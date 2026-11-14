// Nova's voice in the call chat (docs/meeting-assistant-design.md, decisions 4 to 6, 8).
//
// The path. A seatless server post: `postThreadMessage` (lib/social-chat.ts), the same one REST comments and bot-run
// system comments use. It writes the call chat's own message store, then hands the row to the gateway's
// `appendServerMessage` IN-PROCESS, which broadcasts it through the router; every recipient's frame then passes the
// call chat's `filterFrame` (seat check, history floor, `render`). A status change goes through `updateThreadMessage`
// (`ChatService.updateSystemMessage`: persist, then `messageUpdated`). Nothing here opens a socket or presents a
// token to the gateway, so it does not depend on the gateway running with authentication off; with the gateway
// off (a unit test, the BFF alone) the row is stored and readers get it on their next read. That in-process hand-off
// is the ONE coupling, and it lives in `social-chat.ts` (`setThreadLiveAppend` / `setThreadLiveUpdate`).
//
// Who may post: only server code that calls this module. The huddle send path refuses the author and the keys
// (call-chat-send.ts), and `render` only shows the assistant keys on a message Nova authored (call-chat.ts).
//
// When: only while an assistant record exists for the call and is not `left`; the dismiss notice is the one
// exception (`leaving`). A private reply is not a chat message: `postPrivately` goes to one person's notifications.
import { randomBytes } from 'node:crypto';
import type { ChatMessage } from '@connorhoehn/realtime-modules/chat';
import { config } from '../../config.js';
import { getUser } from '../../providers/identity.js';
import { callChatChannel, callChatRuntime } from '../call-chat.js';
import { notify } from '../social-notify.js';
import { postThreadMessage, updateThreadMessage } from '../social-chat.js';
import { assistantStore } from './store-select.js';
import {
  DELETED_RECORD_LINE, NOVA_NAME, NOVA_USER_ID,
  type ActionInput, type AssistantActionStatus, type AssistantMetadata, type ReplyInput,
} from './chat-types.js';

/** The call chat's own message store: the one the seat checks and history reads use. */
const chatStore = () => callChatRuntime().messages;

const messageId = (at: string): string => `${Date.parse(at).toString(36)}${randomBytes(6).toString('hex')}`;

/** A person's display name, never the raw id when a name exists. */
export async function nameOf(userId: string, fallback?: string): Promise<string> {
  if (fallback && fallback !== userId) return fallback;
  try { const u = await getUser(userId); if (u?.displayName) return u.displayName; } catch { /* fall through */ }
  return fallback || userId;
}

export interface PostOptions {
  /** The dismiss notice is a message allowed once the assistant has left. */
  leaving?: boolean;
  /** So is the minutes message after it (and the action cards that message offers): minutes.ts is the only caller. */
  minutes?: boolean;
}

/** Is Nova in this call (a record that has not left)? */
export async function assistantPresent(callId: string): Promise<boolean> {
  const record = await assistantStore().get(callId);
  return !!record && record.state !== 'left';
}

/**
 * Put one message into the call's chat as Nova. Returns the stored message, or null when the assistant is not
 * in the call (no record, or it left) and this is not the leave notice. No seat, no client.
 */
export async function postAsAssistant(callId: string, message: { text: string; metadata: AssistantMetadata }, opts: PostOptions = {}): Promise<ChatMessage | null> {
  const record = await assistantStore().get(callId);
  if (!record || (record.state === 'left' && !opts.leaving && !opts.minutes)) return null;
  const at = new Date().toISOString();
  const row: ChatMessage = {
    id: messageId(at), clientId: 'server:assistant', userId: NOVA_USER_ID, channel: callChatChannel(callId),
    message: message.text, metadata: { ...message.metadata }, timestamp: at,
  };
  await postThreadMessage(row, chatStore());
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// Notices. Plain sentences, no emoji. Names are display names.

export const noticeText = {
  joined: (inviterName: string, retentionDays: number = config.meetingAssistant.transcriptRetentionDays): string =>
    `${NOVA_NAME} joined at ${inviterName}'s invitation. While ${NOVA_NAME} is listening, what you say in this call is sent to the speech provider and kept as text for ${retentionDays} days. Anyone here can pause or dismiss ${NOVA_NAME}.`,
  paused: (name: string): string => `${name} paused ${NOVA_NAME}. Nothing is being heard or stored.`,
  resumed: (name: string): string => `${name} resumed ${NOVA_NAME}. ${NOVA_NAME} is listening again.`,
  dismissed: (name: string, recordedNothing = false): string => `${name} dismissed ${NOVA_NAME}.${recordedNothing ? ' Nothing was recorded, so there are no minutes.' : ''}`,
  voiceOn: (name: string): string => `${name} turned ${NOVA_NAME}'s voice on. Each person can mute it for themselves.`,
  voiceOff: (name: string): string => `${name} turned ${NOVA_NAME}'s voice off.`,
  nothingRecorded: `${NOVA_NAME} left. Nothing was recorded, so there are no minutes.`,
};

export function postNotice(callId: string, text: string, opts: PostOptions = {}): Promise<ChatMessage | null> {
  return postAsAssistant(callId, { text, metadata: { assistant: true, displayName: NOVA_NAME, kind: 'assistant-notice' } }, opts);
}

/** A notice that must never fail the route that caused it: the state change already happened. */
export async function postNoticeQuietly(callId: string, text: string, opts: PostOptions = {}): Promise<void> {
  try { await postNotice(callId, text, opts); } catch (error) { console.warn('[meeting-assistant] notice not posted', (error as Error).message); }
}

// ---------------------------------------------------------------------------------------------------------------
// Replies and action cards.

/** An answer shown to everyone in the call, labelled with who asked (decision 6). */
export function postReply(callId: string, input: ReplyInput): Promise<ChatMessage | null> {
  return postAsAssistant(callId, {
    text: input.text,
    metadata: { assistant: true, displayName: NOVA_NAME, kind: 'assistant-reply', askedBy: input.askedBy, askedByName: input.askedByName, private: false },
  });
}

export interface PostedAction { message: ChatMessage; created: boolean }

/**
 * Offer an action as a card. The store keeps who asked and the decision; the chat message carries the card. The same
 * `actionId` twice posts one card (the second call returns the first). Null when the assistant is not in the call.
 */
export async function postAction(callId: string, input: ActionInput, opts: PostOptions = {}): Promise<PostedAction | null> {
  const store = assistantStore();
  const prior = await store.getAction(callId, input.actionId);
  if (prior) {
    const store2 = chatStore();
    const existing = store2.getMessage ? await store2.getMessage(callChatChannel(callId), prior.messageId) : (await store2.listMessages(callChatChannel(callId), 20_000)).find((m) => m.id === prior.messageId) ?? null;
    return existing ? { message: existing, created: false } : null;
  }
  const status = input.status ?? 'waiting';
  const metadata: AssistantMetadata = {
    assistant: true, displayName: NOVA_NAME, kind: 'assistant-action', actionId: input.actionId, askedBy: input.askedBy, askedByName: input.askedByName,
    summary: input.summary, ...(input.detail?.length ? { detail: input.detail } : {}), tool: input.tool, status,
    ...(input.resultText ? { resultText: input.resultText } : {}),
  };
  const message = await postAsAssistant(callId, { text: input.summary, metadata }, opts);
  if (!message) return null;
  const { created } = await store.createAction({
    callId, actionId: input.actionId, messageId: message.id, askedBy: input.askedBy, toolName: input.tool.name, argsDigest: input.tool.argsDigest,
    status, createdAt: Date.now(), decidedBy: null, decidedAt: null, resultText: input.resultText ?? null,
  });
  return { message, created };
}

export interface ActionMove { from: readonly AssistantActionStatus[]; to: AssistantActionStatus; by: string; at?: number; resultText?: string }

/**
 * Move an action's status and update THE SAME chat message (no new message per status). Null when the action is
 * unknown or not in one of `from` (two clicks decide once). The store is the authority; the message follows it.
 */
export async function moveAction(callId: string, actionId: string, move: ActionMove) {
  const store = assistantStore();
  const decided = await store.decideAction(callId, actionId, { from: move.from, to: move.to, by: move.by, at: move.at ?? Date.now(), ...(move.resultText !== undefined ? { resultText: move.resultText } : {}) });
  if (!decided) return null;
  await updateThreadMessage(callChatChannel(callId), decided.messageId,
    { metadata: { status: decided.status, ...(decided.resultText ? { resultText: decided.resultText } : {}) } }, chatStore());
  return decided;
}

// ---------------------------------------------------------------------------------------------------------------
// A private reply (decision 6: tools about one person's private standing answer only to the asker).
//
// Chosen path: the notifications `notify()` seam (lib/social-notify.ts), to this one user. It is per-user by
// construction, persisted in their inbox (so it survives a reload and a closed tab, which an ephemeral call-chat frame
// would not), and already reaches the bell and toast the portal shows. Nothing is written to the call chat's store.
export async function postPrivately(callId: string, userId: string, input: { text: string; title?: string }): Promise<boolean> {
  const record = await assistantStore().get(callId);
  if (!record || record.state === 'left') return false;
  const sent = await notify([userId], {
    type: 'assistant-private-reply', title: input.title ?? `${NOVA_NAME} (only you can see this)`, body: input.text,
    payload: { tenant: record.tenant, kind: 'assistant-private-reply', callId, assistant: true },
  });
  return sent.includes(userId);
}

// ---------------------------------------------------------------------------------------------------------------
// Erasing Nova's words from a call's chat (audit M2, M3). Only messages authored by the assistant identity change; people's own
// messages are theirs. The text goes through `updateThreadMessage`, the same path a card's status change takes.

/** The most messages of one call chat an erase reads; the update itself is by message id and has no window. */
export const ERASE_SCAN_MAX = 20_000;

/** Replace the text of every message Nova authored in the call's chat with the fixed line; cards lose summary, detail and result. Safe to repeat. Returns how many changed. */
export async function eraseAssistantMessages(callId: string): Promise<number> {
  const channel = callChatChannel(callId);
  const rows = await chatStore().listMessages(channel, ERASE_SCAN_MAX);
  if (rows.length >= ERASE_SCAN_MAX) console.warn(`[meeting-assistant] erase read the ${ERASE_SCAN_MAX} newest messages of a call chat; older ones were not looked at`);
  let changed = 0;
  for (const m of rows) {
    if (m.userId !== NOVA_USER_ID || m.deletedAt) continue;
    const isCard = m.metadata?.['kind'] === 'assistant-action';
    const already = m.message === DELETED_RECORD_LINE && (isCard ? (m.metadata?.['summary'] === DELETED_RECORD_LINE && m.metadata?.['detail'] === undefined && m.metadata?.['resultText'] === undefined) : m.metadata?.['meetingCallId'] === undefined);
    if (already) continue;
    const patch = isCard
      ? { message: DELETED_RECORD_LINE, metadata: { summary: DELETED_RECORD_LINE, detail: undefined, resultText: undefined, tool: { name: String((m.metadata?.['tool'] as { name?: unknown } | undefined)?.name ?? ''), argsDigest: '' } } }
      // A closing notice also loses its link to the meeting page: the page is gone with the record.
      : { message: DELETED_RECORD_LINE, metadata: { meetingCallId: undefined } };
    if (await updateThreadMessage(channel, m.id, patch, chatStore())) changed += 1;
  }
  return changed;
}
