// The call assistant ("Nova") as the portal sees it: the server's state payload
// (middleware routes/meeting-assistant.ts `view`), reduced to what the call bar,
// the roster line and the transcription notice show. Pure, so node:test covers it.

export type AssistantPhase = 'none' | 'invited' | 'listening' | 'paused' | 'left';

export interface AssistantView {
  callId: string;
  phase: AssistantPhase;
  invitedBy: string | null;
  /** The initiative the call was started from (a work item made from a card lands on it), or null. */
  initiativeId: string | null;
  /** Display name of the inviter, when the directory has one. */
  invitedByName: string | null;
  pausedBy: string | null;
  leftBy: string | null;
  /** True when this person has not yet acknowledged the transcription notice. */
  youMustAck: boolean;
  /** Seconds Nova has listened, and the ceiling it leaves at; null while the server has not said. */
  listeningSeconds: number | null;
  ceilingSeconds: number | null;
  /** Nova speaks aloud in this call (off unless an inviter turned it on). */
  voice: boolean;
}

/** The state is refreshed this often while a call is live (docs: keep any poll at 5 s or slower). */
export const ASSISTANT_POLL_MS = 5000;

/** Meetings (the nav entry, the palette row, both routes) exist only while the session says the server runs the feature. */
export const meetingsAdvertised = (session: { meetingAssistant?: boolean } | null | undefined): boolean => session?.meetingAssistant === true;

export const ASSISTANT_NAME = 'Nova';
export const ASSISTANT_LABEL = 'Assistant';

const PHASES: readonly AssistantPhase[] = ['none', 'invited', 'listening', 'paused', 'left'];
const seconds = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Reads one `GET …/assistant/state` (or an action's) body; anything unrecognised reads as "no assistant". */
export function parseAssistantState(callId: string, body: unknown): AssistantView {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const phase = PHASES.find((p) => p === b['state']) ?? 'none';
  return {
    callId, phase,
    invitedBy: text(b['invitedBy']), initiativeId: text(b['initiativeId']), invitedByName: text(b['invitedByName']),
    pausedBy: text(b['pausedBy']), leftBy: text(b['leftBy']),
    youMustAck: phase !== 'none' && phase !== 'left' && b['youMustAck'] === true,
    listeningSeconds: seconds(b['listeningSeconds']), ceilingSeconds: seconds(b['ceilingSeconds']),
    voice: phase !== 'none' && phase !== 'left' && b['voice'] === true,
  };
}

export const NO_ASSISTANT = (callId: string): AssistantView => parseAssistantState(callId, null);

/** Nova is in the call and taking part (listening or paused). */
export const assistantPresent = (v: AssistantView): boolean => v.phase === 'invited' || v.phase === 'listening' || v.phase === 'paused';

/** The state in words, for the call bar and the roster line. Null when there is nothing to say. */
export function assistantStateWords(v: AssistantView): string | null {
  if (v.phase === 'listening' || v.phase === 'invited') return `${ASSISTANT_NAME} is listening`;
  if (v.phase === 'paused') return `${ASSISTANT_NAME} is paused`;
  if (v.phase === 'left') return `${ASSISTANT_NAME} has left this call`;
  return null;
}

export interface AssistantControls {
  /** The whole feature is hidden: flag off, or no call. */
  hidden: boolean;
  invite: boolean;
  pause: boolean;
  resume: boolean;
  dismiss: boolean;
  /** This person has not acknowledged yet: Nova cannot hear them, and the mark says so and offers the acknowledgement. */
  acknowledge: boolean;
  /** Add time to the ceiling: people who may invite Nova, while it is in the call. */
  extend: boolean;
  /** Nova left this call; the server refuses a re-invite, so the bar says so instead of offering Invite. */
  left: boolean;
}

/** What the call bar offers. Invite needs the capability; pause, resume and dismiss are for everyone in the call. */
export function assistantControls(input: { enabled: boolean; inCall: boolean; canInvite: boolean; view: AssistantView }): AssistantControls {
  const off: AssistantControls = { hidden: true, invite: false, pause: false, resume: false, dismiss: false, acknowledge: false, extend: false, left: false };
  if (!input.enabled || !input.inCall) return off;
  const { phase } = input.view;
  return {
    hidden: false,
    invite: phase === 'none' && input.canInvite,
    pause: phase === 'listening' || phase === 'invited',
    resume: phase === 'paused',
    dismiss: assistantPresent(input.view),
    acknowledge: assistantPresent(input.view) && input.view.youMustAck,
    extend: (phase === 'listening' || phase === 'paused') && input.canInvite,
    left: phase === 'left',
  };
}

/** The transcription notice shows to someone who still owes an acknowledgement while Nova is in the call. */
export const noticeVisible = (enabled: boolean, v: AssistantView): boolean => enabled && assistantPresent(v) && v.youMustAck;

/** The notice's sentences. Plain words: who invited, where speech goes, how long it is kept, what is kept before you agree. */
export function noticeText(v: AssistantView): { title: string; body: string } {
  const who = v.invitedByName ?? 'A participant';
  return {
    title: `${who} invited ${ASSISTANT_NAME} to listen to this call`,
    body: `${ASSISTANT_NAME} sends what is said to a speech provider and keeps it as text for 30 days. Nothing you say is kept until you acknowledge.`,
  };
}

/** The roster line for the people lists the call surfaces already have ("Nova (Assistant, listening)"). */
export function rosterEntry(v: AssistantView): string | null {
  if (!assistantPresent(v)) return null;
  return `${ASSISTANT_NAME} (${ASSISTANT_LABEL}, ${v.phase === 'paused' ? 'paused' : 'listening'})`;
}

/** Minutes before Nova leaves (rounded up), or null when the server has not said. Never negative. */
export function minutesLeft(v: AssistantView): number | null {
  if (v.listeningSeconds === null || v.ceilingSeconds === null) return null;
  return Math.max(0, Math.ceil((v.ceilingSeconds - v.listeningSeconds) / 60));
}

/** The warning is shown from this many minutes before Nova leaves. */
export const LEFT_WARNING_MINUTES = 10;

/** "8 min left" while Nova is listening and the end is near; null otherwise. */
export function timeLeftWords(v: AssistantView): string | null {
  if (v.phase !== 'listening' && v.phase !== 'invited') return null;
  const m = minutesLeft(v);
  return m !== null && m < LEFT_WARNING_MINUTES ? `${m} min left` : null;
}

/** What the mark says: the state, or, once the notice was closed without acknowledging, that Nova cannot hear this person yet. */
export function markWords(v: AssistantView, noticeClosed: boolean): string | null {
  if (noticeClosed && assistantPresent(v) && v.youMustAck) return `${ASSISTANT_NAME} cannot hear you yet`;
  return assistantStateWords(v);
}
