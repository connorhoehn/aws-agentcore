// What Nova puts in the call chat (docs/meeting-assistant-design.md, decisions 4 to 6). One file, shared by the
// server's posting (chat.ts), the render gate in lib/call-chat.ts and the tests. The portal keeps a mirror of the
// metadata shapes in portal/src/lib/assistantMessages.ts; change both together.
//
// The identity is fixed. A message is Nova's only if it was stored by chat.ts: `userId` is NOVA_USER_ID, and
// `metadata.assistant === true` with `metadata.kind` starting `assistant-`. No signed-in client can produce one:
// the huddle send path (call-chat-send.ts) refuses the author and the keys, and `render` (call-chat.ts) shows the
// assistant keys only on a message whose stored author is Nova.

export const NOVA_USER_ID = 'agent:nova';
export const NOVA_NAME = 'Nova' as const;
/** What Nova's own chat messages say once their call's record is deleted (by the inviter, or by retention). */
export const DELETED_RECORD_LINE = 'This record was deleted by the person who invited Nova.';
export const ASSISTANT_KIND_PREFIX = 'assistant-';

export type AssistantKind = 'assistant-notice' | 'assistant-reply' | 'assistant-action';
export const ASSISTANT_KINDS: readonly AssistantKind[] = ['assistant-notice', 'assistant-reply', 'assistant-action'];

export type AssistantActionStatus = 'waiting' | 'confirmed' | 'declined' | 'expired' | 'done' | 'failed';
export const ACTION_STATUSES: readonly AssistantActionStatus[] = ['waiting', 'confirmed', 'declined', 'expired', 'done', 'failed'];

/** Fields every Nova message carries. */
export interface AssistantBase { assistant: true; displayName: typeof NOVA_NAME }

export interface AssistantNoticeMetadata extends AssistantBase {
  kind: 'assistant-notice';
  /** The closing notice names the meeting it is about; the portal links to that meeting's page from it. */
  meetingCallId?: string;
}

export interface AssistantReplyMetadata extends AssistantBase {
  kind: 'assistant-reply';
  askedBy: string;
  askedByName: string;
  /** Always false in a chat message; a private reply is never a chat message (postPrivately). */
  private?: false;
}

export interface AssistantActionMetadata extends AssistantBase {
  kind: 'assistant-action';
  actionId: string;
  askedBy: string;
  askedByName: string;
  summary: string;
  detail?: string[];
  tool: { name: string; argsDigest: string };
  status: AssistantActionStatus;
  resultText?: string;
}

export type AssistantMetadata = AssistantNoticeMetadata | AssistantReplyMetadata | AssistantActionMetadata;

/** What the caller supplies for each kind; chat.ts adds `assistant`, `displayName` and `kind`. */
export type ReplyInput = { text: string; askedBy: string; askedByName: string };
export type ActionInput = Omit<AssistantActionMetadata, keyof AssistantBase | 'kind' | 'status'> & { status?: AssistantActionStatus };

export const isAssistantKind = (kind: unknown): boolean => typeof kind === 'string' && kind.startsWith(ASSISTANT_KIND_PREFIX);

/** Does a metadata bag carry anything only Nova may carry? Used to refuse a person's send. */
export function claimsAssistant(metadata: Record<string, unknown> | undefined | null): boolean {
  if (!metadata) return false;
  return 'assistant' in metadata || isAssistantKind(metadata['kind']);
}

const str = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Parse stored metadata back into a typed shape; null when it is not a well-formed Nova message. */
export function parseAssistantMetadata(raw: unknown): AssistantMetadata | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m['assistant'] !== true) return null;
  const base = { assistant: true as const, displayName: NOVA_NAME };
  if (m['kind'] === 'assistant-notice') return { ...base, kind: 'assistant-notice', ...(str(m['meetingCallId'], 200) ? { meetingCallId: m['meetingCallId'] } : {}) };
  if (m['kind'] === 'assistant-reply') {
    if (!str(m['askedBy'], 128) || !str(m['askedByName'], 128)) return null;
    return { ...base, kind: 'assistant-reply', askedBy: m['askedBy'], askedByName: m['askedByName'], ...(m['private'] === false ? { private: false as const } : {}) };
  }
  if (m['kind'] === 'assistant-action') {
    const tool = m['tool'] as Record<string, unknown> | undefined;
    if (!str(m['actionId'], 128) || !str(m['askedBy'], 128) || !str(m['askedByName'], 128) || !str(m['summary'], 500)
      || !tool || !str(tool['name'], 128) || typeof tool['argsDigest'] !== 'string' || !ACTION_STATUSES.includes(m['status'] as AssistantActionStatus)) return null;
    const detail = Array.isArray(m['detail']) && m['detail'].every((x) => typeof x === 'string') ? (m['detail'] as string[]) : undefined;
    return { ...base, kind: 'assistant-action', actionId: m['actionId'], askedBy: m['askedBy'], askedByName: m['askedByName'], summary: m['summary'],
      ...(detail ? { detail } : {}), tool: { name: tool['name'], argsDigest: tool['argsDigest'] }, status: m['status'] as AssistantActionStatus,
      ...(typeof m['resultText'] === 'string' ? { resultText: m['resultText'] } : {}) };
  }
  return null;
}
