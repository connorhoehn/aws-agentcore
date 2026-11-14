// What happens when the assistant leaves (docs/meeting-assistant-design.md, package 5): write the minutes once, say so in
// the call chat, and offer each owned action item to its owner. Called from the runtime's `onFinished` (dismiss, the
// ceiling, a lost connection) and from the call-end signal (lib/call-chat.ts `onCallChatFinished`), so every way of
// leaving ends here; the first writer wins (`putMinutes` is idempotent on the call id) and a deleted record is never
// written again (the tombstone).
//
// Privacy: minutes are the attendees' (routes/meeting-assistant.ts `attendeeOf`). Nothing here widens that.
import { createHash } from 'node:crypto';
import { getProject } from '../../providers/projects.js';
import { hashToolArgs, voiceTool } from '../voice/catalogue.js';
import { delegationCostUsd, delegationModel } from '../voice/ledger.js';
import { voiceProviderConfigured } from '../voice/openai.js';
import { callChatRuntime } from '../call-chat.js';
import { nameOf, postAction, postAsAssistant, postNoticeQuietly, noticeText } from './chat.js';
import { NOVA_NAME } from './chat-types.js';
import { meetingTools } from './instructions.js';
import {
  capTranscript, MINUTES_TIMEOUT_MS, MinutesWriterError, OpenAiMinutesWriter, ScriptedMinutesWriter, type MinutesDraft, type MinutesWriter, type RosterEntry,
} from './minutes.js';
import { assistantStore } from './store-select.js';
import { minutesSpend, SCRIPTED_MINUTES_USD } from './spend.js';
import { mockTranscriptEnabled } from './transcript-source.js';
import type { AssistantRecord, AssistantTurn, MinutesRecord, MinutesWriterKind, TranscriptLine } from './types.js';

/** Where the meeting page lives in the portal (`/iq/meetings/:callId`); the chat message and the notification link to it. */
export const meetingPagePath = (callId: string): string => `/iq/meetings/${encodeURIComponent(callId)}`;

export type MinutesWriterFactory = () => MinutesWriter | null;

export const defaultMinutesWriterFactory: MinutesWriterFactory = () => {
  if (mockTranscriptEnabled()) return new ScriptedMinutesWriter();
  return voiceProviderConfigured() ? new OpenAiMinutesWriter() : null;
};
let writerFactory: MinutesWriterFactory | null = null;
export function setMinutesWriterFactory(next: MinutesWriterFactory | null): void { writerFactory = next; }

const NOTES = {
  budget: 'Minutes could not be written because the inviter\'s budget did not allow it. The transcript is kept; the people who were in the call can read it.',
  failed: 'Minutes could not be written this time. The transcript is kept; the people who were in the call can read it.',
  noWriter: 'Minutes are not available in this deployment. The transcript is kept; the people who were in the call can read it.',
} as const;

/** Writes in flight, so a test (and a shutdown) can wait for them. */
const inFlight = new Set<Promise<unknown>>();
export async function minutesIdle(): Promise<void> { while (inFlight.size) await Promise.allSettled([...inFlight]); }
export function trackMinutes<T>(p: Promise<T>): Promise<T> { return track(p); }
function track<T>(p: Promise<T>): Promise<T> { inFlight.add(p); const done = () => { inFlight.delete(p); }; p.then(done, done); return p; }

async function allLines(callId: string): Promise<TranscriptLine[]> {
  const store = assistantStore();
  const out: TranscriptLine[] = [];
  for (let after = 0; ;) {
    const page = await store.lines(callId, after, 500);
    if (!page.length) return out;
    out.push(...page); after = page[page.length - 1]!.seq;
    if (out.length > 200_000) return out;
  }
}

/** The call's name for the minutes: the initiative's name when it has one. */
async function callNameOf(record: AssistantRecord): Promise<string> {
  if (!record.initiativeId) return 'Call';
  try { const name = (await getProject(record.initiativeId))?.name; return name ? `${name} call` : 'Call'; } catch { return 'Call'; }
}

/** Is the call still running with this person seated? (A card needs the owner's browser in the call.) */
async function seatedNow(callId: string): Promise<Set<string>> {
  try {
    if (!(await callChatRuntime().lobbyOf(callId))) return new Set();
    return new Set((await callChatRuntime().seatedUsers(callId)).filter((u) => u.active).map((u) => u.userId));
  } catch { return new Set(); }
}

/** The "create" call's arguments for a work item, with every field the strict schema names present (null when unused). */
export function createWorkItemArgs(title: string, initiativeName: string | null): { kind: string; fields: Record<string, string | null> } {
  const fieldsSchema = ((voiceTool('create')?.parameters as { properties?: { fields?: { properties?: Record<string, unknown> } } } | undefined)?.properties?.fields?.properties) ?? {};
  const fields: Record<string, string | null> = Object.fromEntries(Object.keys(fieldsSchema).map((k) => [k, null]));
  fields['title'] = title.slice(0, 200);
  if (initiativeName) fields['initiative'] = initiativeName.slice(0, 200);
  return { kind: 'work-item', fields };
}

const WRITE_CARD_TTL_MS = 10 * 60_000;
const MAX_CARDS = 8;

/** The first sentences of the summary for the chat (two or three). */
function chatSummary(summary: string): string {
  const sentences = summary.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [];
  return sentences.slice(0, 3).join('').trim().slice(0, 500);
}

async function writeDraft(record: AssistantRecord, writer: MinutesWriter, input: Parameters<MinutesWriter['write']>[0]): Promise<{ draft: MinutesDraft | null; note: string | null; writer: MinutesWriterKind }> {
  const spend = minutesSpend();
  const common = { callId: record.callId, tenant: record.tenant, inviterId: record.invitedBy, initiativeId: record.initiativeId };
  if (writer.kind === 'scripted') {
    const draft = await writer.write(input);
    await spend.record({ ...common, model: 'scripted-minutes', costUsd: SCRIPTED_MINUTES_USD, basis: 'estimated' }).catch((e: unknown) => console.warn('[meeting-assistant] minutes spend not booked', (e as Error).message));
    return { draft, note: null, writer: 'scripted' };
  }
  const model = delegationModel();
  const capped = capTranscript(input.lines, input.roster);
  const bytes = capped.lines.reduce((n, l) => n + l.text.length + 24, 0);
  const estimate = await delegationCostUsd(model, { inputTokens: Math.ceil(bytes / 4) + 400, outputTokens: 2000, cachedTokens: 0, responses: 1 }).catch(() => null);
  const estimateUsd = Math.round((estimate ?? 0.05) * 1.5 * 10_000) / 10_000;
  const held = await spend.reserve({ ...common, estimateUsd });
  if (!held.ok) return { draft: null, note: NOTES.budget, writer: 'none' };
  try {
    const draft = await writer.write(input);
    const usage = draft.usage;
    const cost = usage ? await delegationCostUsd(model, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: Math.min(usage.cachedTokens, usage.inputTokens), responses: 1 }).catch(() => null) : null;
    await spend.record({
      ...common, model, costUsd: cost ?? estimate, basis: cost != null ? 'reported' : estimate != null ? 'estimated' : 'unknown',
      ...(usage ? { tokensIn: usage.inputTokens, tokensOut: usage.outputTokens } : {}),
    }).catch((e: unknown) => console.warn('[meeting-assistant] minutes spend not booked', (e as Error).message));
    return { draft, note: null, writer: 'openai' };
  } catch (e) {
    console.warn('[meeting-assistant] minutes writer failed', (e as Error).message);
    // A failure after the request went out still cost something: book the reported usage, or an estimate. Before that, nothing.
    if (e instanceof MinutesWriterError && e.requestSent) {
      const u = e.usage;
      const cost = u ? await delegationCostUsd(model, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedTokens: Math.min(u.cachedTokens, u.inputTokens), responses: 1 }).catch(() => null) : null;
      await spend.record({
        ...common, model, costUsd: cost ?? estimate, basis: cost != null ? 'reported' : estimate != null ? 'estimated' : 'unknown',
        ...(u ? { tokensIn: u.inputTokens, tokensOut: u.outputTokens } : {}),
      }).catch((err: unknown) => console.warn('[meeting-assistant] minutes spend not booked', (err as Error).message));
    }
    await spend.release(held.holdId ? [held.holdId] : []);
    return { draft: null, note: NOTES.failed, writer: 'none' };
  }
}

/** Offer each owned action item to its owner as a "Create a work item" card, only while the owner is still in the live call. */
async function offerCards(record: AssistantRecord, minutes: MinutesRecord, initiativeName: string | null): Promise<number> {
  const store = assistantStore();
  const seated = await seatedNow(record.callId);
  if (!seated.size) return 0;
  let cards = 0;
  for (const [i, item] of minutes.actionItems.entries()) {
    if (cards >= MAX_CARDS) break;
    const owner = item.ownerUserId;
    if (item.done || !owner || !seated.has(owner) || !minutes.attendees.includes(owner)) continue;
    const roles = await import('./orchestrator.js').then((m) => m.defaultRolesOf(owner, record.tenant)).catch(() => [] as string[]);
    if (!roles.some((role) => meetingTools(record.tenant, role).some((t) => t.name === 'create'))) continue;
    const args = createWorkItemArgs(item.text, initiativeName);
    const key = createHash('sha256').update(`${record.callId}:${i}`).digest('hex').slice(0, 16);
    const actionId = `m-${key}`;
    const now = Date.now();
    const turn: AssistantTurn = { turnId: `t-m-${key}`, callId: record.callId, askedBy: owner, tool: { name: 'create', args }, kind: 'write', status: 'pending', actionId, createdAt: now, expiresAt: now + WRITE_CARD_TTL_MS };
    const made = await store.createTurn(turn);
    if (!made.created) continue;
    const posted = await postAction(record.callId, {
      actionId, askedBy: owner, askedByName: item.ownerName ?? await nameOf(owner), summary: `Create a work item: ${item.text}`,
      detail: [`title: ${item.text.slice(0, 120)}`], tool: { name: 'create', argsDigest: hashToolArgs(args) },
    }, { minutes: true }).catch(() => null);
    if (!posted) { await store.moveTurn(record.callId, turn.turnId, { from: ['pending'], to: 'expired' }); continue; }
    cards += 1;
  }
  return cards;
}

/**
 * Write the minutes for a call whose assistant has left, once. Returns the stored minutes, or null when there is nothing to
 * write (no assistant, still in the call, no lines recorded, or the record was deleted).
 */
export function writeMinutes(callId: string): Promise<MinutesRecord | null> {
  const running = writing.get(callId);
  if (running) return running;
  const p = writeMinutesOnce(callId).finally(() => { writing.delete(callId); });
  writing.set(callId, p);
  return p;
}
const writing = new Map<string, Promise<MinutesRecord | null>>();

async function writeMinutesOnce(callId: string): Promise<MinutesRecord | null> {
  const store = assistantStore();
  const record = await store.get(callId);
  if (!record || record.state !== 'left') return null;
  if (await store.getMinutes(callId)) return null;
  const lines = await allLines(callId);
  if (!lines.length) {
    // Nothing was recorded: no minutes. A person's dismissal already said so in its own notice; the other ways of leaving say it here.
    if (record.leftBy === 'system') await postNoticeQuietly(callId, noticeText.nothingRecorded, { minutes: true });
    return null;
  }

  const attendees = [...new Set([...record.attendees, ...lines.flatMap((l) => (l.userId ? [l.userId] : []))])];
  const roster: RosterEntry[] = await Promise.all(attendees.map(async (userId) => ({ userId, name: await nameOf(userId) })));
  const callName = await callNameOf(record);
  const initiativeName = record.initiativeId ? await getProject(record.initiativeId).then((p) => p?.name ?? null).catch(() => null) : null;
  const turns = await store.listTurns(callId, { statuses: ['done'] }).catch(() => [] as AssistantTurn[]);
  const doneActions = turns.filter((t) => t.kind === 'write').map((t) => ({ text: doneActionText(t), ownerUserId: t.askedBy }));

  const writer = (writerFactory ?? defaultMinutesWriterFactory)();
  let result: { draft: MinutesDraft | null; note: string | null; writer: MinutesWriterKind } = { draft: null, note: NOTES.noWriter, writer: 'none' };
  if (writer) {
    result = await Promise.race([
      writeDraft(record, writer, { lines, roster, callName, doneActions }),
      new Promise<typeof result>((resolve) => { const t = setTimeout(() => resolve({ draft: null, note: NOTES.failed, writer: 'none' }), MINUTES_TIMEOUT_MS * 2 + 5000); t.unref?.(); }),
    ]);
  }
  const draft = result.draft;
  const minutes: MinutesRecord = {
    callId, tenant: record.tenant, lobby: record.lobby, initiativeId: record.initiativeId, callName,
    startedAt: record.invitedAt, endedAt: record.leftAt ?? Date.now(), invitedBy: record.invitedBy, attendees,
    summary: draft ? draft.summary : result.note ?? NOTES.failed, decisions: draft?.decisions ?? [], actionItems: draft?.actionItems ?? [], topics: draft?.topics ?? [],
    lineCount: lines.length, truncated: draft?.truncated ?? false, writer: result.writer, createdAt: Date.now(),
  };
  const stored = await store.putMinutes(minutes);
  if (!stored.created || stored.minutes.deleted) return null;

  const words = `${stored.minutes.decisions.length} ${stored.minutes.decisions.length === 1 ? 'decision' : 'decisions'} and ${stored.minutes.actionItems.length} ${stored.minutes.actionItems.length === 1 ? 'action item' : 'action items'}`;
  const head = draft ? chatSummary(stored.minutes.summary) : stored.minutes.summary;
  // The page is a metadata field the chat renders as a link; the sentence carries no path.
  const sentence = (draft ? `${NOVA_NAME}'s minutes: ${head} ${words}.` : head).replace(/\s+/g, ' ');
  await postAsAssistant(callId, { text: sentence, metadata: { assistant: true, displayName: NOVA_NAME, kind: 'assistant-notice', meetingCallId: callId } }, { minutes: true })
    .catch((error: unknown) => console.warn('[meeting-assistant] notice not posted', (error as Error).message));
  if (draft) await offerCards(record, stored.minutes, initiativeName).catch((e: unknown) => console.warn('[meeting-assistant] action cards not offered', (e as Error).message));
  return stored.minutes;
}

function doneActionText(turn: AssistantTurn): string {
  const a = (turn.tool.args ?? {}) as { kind?: unknown; fields?: { title?: unknown; name?: unknown } };
  const title = typeof a.fields?.title === 'string' ? a.fields.title : typeof a.fields?.name === 'string' ? a.fields.name : '';
  const kind = typeof a.kind === 'string' ? a.kind.replace(/-/g, ' ') : '';
  return turn.tool.name === 'create' && title ? `Created ${kind || 'a record'}: ${title}` : `Ran ${turn.tool.name}`;
}

/** The runtime's `onFinished` and the call-end signal call this; it never throws and never blocks the caller. */
export function finishMinutes(callId: string): Promise<void> {
  return track(writeMinutes(callId).then(() => undefined, (e: unknown) => { console.warn('[meeting-assistant] minutes failed', (e as Error).message); }));
}

/**
 * The call ended while the assistant was present: it leaves with the call (the same settle as a dismissal), then the minutes
 * are written. Nothing is posted into the chat but the minutes message: the call is over.
 */
export async function onCallEnded(callId: string, deps: { stop: (callId: string) => Promise<void>; stopIntake: (callId: string) => void }): Promise<void> {
  const store = assistantStore();
  const record = await store.get(callId);
  if (!record) return;
  if (record.state !== 'left') {
    const done = await store.transition(callId, { from: ['invited', 'listening', 'paused'], to: 'left', by: 'system', at: Date.now() });
    if (!done) return;
  }
  deps.stopIntake(callId);
  await deps.stop(callId);
  // `stop` runs `onFinished` only for a call with a live run; make sure the minutes are written either way.
  await finishMinutes(callId);
}
