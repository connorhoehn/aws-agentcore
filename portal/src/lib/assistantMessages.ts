// What Nova puts in the call chat, as the portal reads it. The shapes mirror
// middleware/src/lib/meeting-assistant/chat-types.ts; change both together.
//
// Trust: the BFF shows these keys only on a message whose stored author is the assistant's fixed identity
// (lib/call-chat.ts `render`), and refuses them from a person on the way in, so a message that carries them here
// is Nova's. This file still validates the shape so a malformed row renders as an ordinary message, not a broken card.

import { pokeTurns } from './meetingTurnsPoke.ts';

export type AssistantActionStatus = 'waiting' | 'confirmed' | 'declined' | 'expired' | 'done' | 'failed';
const STATUSES: readonly AssistantActionStatus[] = ['waiting', 'confirmed', 'declined', 'expired', 'done', 'failed'];

export interface AssistantNotice { kind: 'assistant-notice'; /** The meeting this notice closes; the chat links to its page. */ meetingCallId?: string }
export interface AssistantReply { kind: 'assistant-reply'; askedBy: string; askedByName: string }
export interface AssistantAction {
  kind: 'assistant-action';
  actionId: string;
  askedBy: string;
  askedByName: string;
  summary: string;
  detail: string[];
  tool: { name: string; argsDigest: string };
  status: AssistantActionStatus;
  resultText?: string;
}
export type AssistantMessage = AssistantNotice | AssistantReply | AssistantAction;

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The assistant message a chat message's metadata describes, or null for anything else. */
export function readAssistantMessage(metadata: Record<string, unknown> | undefined): AssistantMessage | null {
  if (!metadata || metadata['assistant'] !== true) return null;
  if (metadata['kind'] === 'assistant-notice') return { kind: 'assistant-notice', ...(text(metadata['meetingCallId']) ? { meetingCallId: metadata['meetingCallId'] } : {}) };
  if (metadata['kind'] === 'assistant-reply') {
    return text(metadata['askedBy']) && text(metadata['askedByName'])
      ? { kind: 'assistant-reply', askedBy: metadata['askedBy'], askedByName: metadata['askedByName'] } : null;
  }
  if (metadata['kind'] === 'assistant-action') {
    const tool = metadata['tool'];
    const status = metadata['status'];
    if (!text(metadata['actionId']) || !text(metadata['askedBy']) || !text(metadata['askedByName']) || !text(metadata['summary'])
      || !tool || typeof tool !== 'object' || !text((tool as Record<string, unknown>)['name']) || !STATUSES.includes(status as AssistantActionStatus)) return null;
    const detail = Array.isArray(metadata['detail']) ? metadata['detail'].filter((x): x is string => typeof x === 'string') : [];
    return {
      kind: 'assistant-action', actionId: metadata['actionId'], askedBy: metadata['askedBy'], askedByName: metadata['askedByName'], summary: metadata['summary'], detail,
      tool: { name: String((tool as Record<string, unknown>)['name']), argsDigest: String((tool as Record<string, unknown>)['argsDigest'] ?? '') },
      status: status as AssistantActionStatus, ...(text(metadata['resultText']) ? { resultText: metadata['resultText'] } : {}),
    };
  }
  return null;
}

/** The line under a reply: who asked. */
export const askedByLine = (reply: Pick<AssistantReply, 'askedByName'>): string => `Asked by ${reply.askedByName}`;

/** What a card says about itself and what the viewer may do. Only the asker may decide, and only while it waits. */
export interface ActionCardView {
  statusLabel: string;
  tone: 'info' | 'success' | 'warning' | 'error' | 'neutral' | 'pending';
  /** Active Confirm and Decline: the asker, while waiting. */
  canDecide: boolean;
  /** For everyone else, while it waits: "Waiting for Una". */
  waitingNote: string | null;
}

export function actionCardView(action: AssistantAction, viewerId: string | null): ActionCardView {
  const asker = viewerId !== null && viewerId === action.askedBy;
  const waiting = action.status === 'waiting';
  const label: Record<AssistantActionStatus, [string, ActionCardView['tone']]> = {
    waiting: ['Waiting for confirmation', 'pending'], confirmed: ['Confirmed, running', 'info'], declined: ['Declined', 'neutral'],
    expired: ['Expired', 'warning'], done: ['Done', 'success'], failed: ['Failed', 'error'],
  };
  const [statusLabel, tone] = label[action.status];
  return { statusLabel, tone, canDecide: asker && waiting, waitingNote: waiting && !asker ? `Waiting for ${action.askedByName}` : null };
}

export type ActionDecision = 'confirm' | 'decline';

/** POST the asker's decision; the server updates the card's message, which reaches every reader as an ordinary edit. */
export async function decideAssistantAction(callId: string, actionId: string, decision: ActionDecision, request: typeof fetch = fetch): Promise<void> {
  const response = await request(`/api/calls/${encodeURIComponent(callId)}/assistant/actions/${encodeURIComponent(actionId)}/decision`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
  });
  if (response.ok) { pokeTurns(callId); return; }
  const json: unknown = await response.json().catch(() => null);
  const message = json && typeof json === 'object' && typeof (json as Record<string, unknown>)['error'] === 'string' ? String((json as Record<string, unknown>)['error']) : '';
  throw new Error(message || `The decision could not be saved (${response.status}).`);
}

/** A new work item whose arguments (listed in the card's detail lines) name no initiative lands on the call's own: only then does the card say which. */
export const namesNoInitiative = (action: Pick<AssistantAction, 'tool' | 'detail'>): boolean =>
  action.tool.name === 'create' && action.detail.some((l) => /^kind:\s*work-item\s*$/i.test(l)) && !action.detail.some((l) => /^initiative\b/i.test(l));
