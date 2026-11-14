// The meeting assistant's routes (docs/meeting-assistant-design.md), mounted at /api/calls/:callId/assistant.
//
//   POST invite      InviteMeetingAssistant + a seat. Creates the record and starts listening.
//   POST pause       a seat. Anyone in the call can pause (decision 8).
//   POST resume      a seat.
//   POST dismiss     a seat. Final: the assistant leaves.
//   POST ack         a seat. Acknowledges the transcription notice; until then your lines are not stored.
//   POST voice       InviteMeetingAssistant + a seat. { on: boolean }: Nova speaks aloud in this call (off by default) or stops. One notice in the call chat.
//   POST participant a seat. { participantId }: bind YOUR media participant id (the per-join id the media server minted for your seat)
//                    to yourself, so audio the taps send under that id is yours. The id must be `<your user id>-<base36 stamp>`.
//   POST actions/:actionId/decision  a seat, and ONLY the person the action was offered to. { decision: 'confirm' | 'decline' }.
//   POST extend       InviteMeetingAssistant + a seat. Adds the default minutes to the call's listening ceiling, up to the hard maximum,
//                      and holds the money for them against the inviter. { confirmOverUserBudget? }
//   GET  turns?mine=1  a seat. The tool calls waiting for MY browser: pending reads, and writes I confirmed (running), not yet claimed. Only mine.
//   POST turns/:turnId/claim   a seat, ONLY the asker (404 otherwise). Claims the turn for this browser before it runs: { turnId, claimId, tool, kind };
//                      a second claim, an expired turn or one not runnable yet is 409.
//   POST turns/:turnId/result  a seat, and ONLY the person the turn was made for (404 for anyone else). { claimId, ok, output?, error? }:
//                      the browser's result of running the tool as that person (400 without claimId, 409 when it is not the claim). The server
//                      hands it to the live session as data, except a private read's `output.say`, which only the asker is shown.
//   GET  state       a seat. State, who invited, who still owes an ack, counters, pending requests.
//   GET  transcript  people who hold or held a seat in this call, nobody else (admins included).
//   GET  minutes     the same rule (`attendeeOf`): the notes the assistant left. 404 for everyone else, and while there are none.
//   DELETE minutes | transcript   the INVITER only (an attendee who is not gets 403; anyone else 404): deletes the minutes AND the
//                    transcript lines and leaves a tombstone, so they are never written again. Only after the assistant has left.
//   (This file also exports `meetingsRouter`, mounted at /api/meetings: the caller's own attended meetings.)
//
// Every route needs: the flag on (else 404), the orgiq tenant, and a currently connected seat of THIS call
// (lib/call-chat.ts assertMember) — except the transcript, which also serves people who have left or after
// the call ended, by attendance. Every route is refused under a masquerade, reads included: they show a person's own turns and the call's words.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { requireAction, requireTenant, resolveSession } from '../lib/authz.js';
import { callChatRuntime, onCallChatFinished } from '../lib/call-chat.js';
import type { Session } from '../lib/session.js'; import { getUser } from '../providers/identity.js';
import {
  assistantIntake, assistantStore, initiativeOfLobby, meetingAssistantEnabled, TranscriptSourceNotConfigured,
  type AssistantRecord,
} from '../lib/meeting-assistant/index.js';
import { moveAction, nameOf, noticeText, postNoticeQuietly } from '../lib/meeting-assistant/chat.js';
import { eraseCall } from '../lib/meeting-assistant/erase.js';
import { assistantRuntime, MAX_RESULT_BYTES, type StartContext } from '../lib/meeting-assistant/orchestrator.js';
import { assistantAudio } from '../lib/meeting-assistant/audio-select.js';
import { preflightAudio, tapArmer, type Preflight } from '../lib/meeting-assistant/media.js';
import { onCallEnded, trackMinutes } from '../lib/meeting-assistant/minutes-service.js';
import { sessionAvailable } from '../lib/meeting-assistant/session-select.js';
import { newAssistantSession, sessionOf as recordSession, type AssistantSession } from '../lib/meeting-assistant/types.js';
import { assistantLimits } from '../lib/meeting-assistant/limits.js';
import { assistantSpend, listeningSecondsOf } from '../lib/meeting-assistant/spend.js';
import { getProject } from '../providers/projects.js';
import { config } from '../config.js';

export const meetingAssistantRouter = Router({ mergeParams: true });


function sessionOf(req: Request): Session {
  const s = resolveSession(req);
  if (!s) throw new AppError(401, 'Unauthenticated');
  return s;
}
function callIdOf(req: Request): string {
  const id = req.params['callId'];
  if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(id)) throw new ValidationError('Invalid call id');
  return id;
}

/** With the flag off the feature does not exist: 404, not 403. */
function flagGate(_req: Request, res: Response, next: NextFunction): void {
  if (!meetingAssistantEnabled()) { res.status(404).json({ error: 'Not found' }); return; }
  next();
}

/**
 * Every route here is about one person: writes are attributed to them, and reads (state, the transcript, their turns, the minutes)
 * show what was said while they were there. A masquerade splits that identity, so every method is refused (audit B5).
 */
function refuseMasquerade(req: Request, res: Response, next: NextFunction): void {
  if (resolveSession(req)?.act) {
    res.status(403).json({ error: 'stop masquerading to use the meeting assistant; it acts for, and shows words to, the person who was there', code: 'MASQUERADING' });
    return;
  }
  next();
}

meetingAssistantRouter.use(flagGate, requireTenant('orgiq'), refuseMasquerade);

const seatOf = async (req: Request): Promise<{ session: Session; callId: string }> => {
  const session = sessionOf(req); const callId = callIdOf(req);
  await callChatRuntime().assertMember(callId, session, false);
  // A connected seat while the assistant is in the call is attendance (the store ignores it once the assistant has left, audit M1).
  await assistantStore().attend(callId, session.sub).catch(() => undefined);
  return { session, callId };
};

/** Seat holders who have not acknowledged: everyone known to be present or to have been, minus the inviter and the acked. */
async function mustAck(record: AssistantRecord, callId: string): Promise<string[]> {
  const live = (await callChatRuntime().seatedUsers(callId).catch(() => [])).filter((u) => u.active).map((u) => u.userId);
  const everyone = new Set([...record.presentAtInvite, ...record.attendees, ...live]);
  return [...everyone].filter((u) => u !== record.invitedBy && !record.acked.includes(u)).sort();
}

async function view(record: AssistantRecord | null, callId: string, session: Session) {
  if (!record) return { callId, state: 'none' as const };
  const owing = await mustAck(record, callId); const invitedByName = (await getUser(record.invitedBy).catch(() => null))?.displayName ?? null; // null: the directory lost them, the notice says "A participant"
  return {
    callId, state: record.state, lobby: record.lobby, initiativeId: record.initiativeId,
    invitedBy: record.invitedBy, invitedByName, invitedAt: record.invitedAt, pausedBy: record.pausedBy, leftAt: record.leftAt, leftBy: record.leftBy,
    mustAck: owing, youMustAck: owing.includes(session.sub),
    counters: { requests: record.requests, linesStored: record.linesStored },
    refusedCalls: recordSession(record).refusedCalls,
    listeningSeconds: Math.floor(listeningSecondsOf(record, assistantRuntime().deps.clock())),
    ceilingSeconds: recordSession(record, assistantLimits().maxSeconds).ceilingSeconds,
    pendingRequests: record.pendingRequests,
    voice: record.voice === true,
    ...assistantRuntime().voiceStats(callId),
    ...assistantRuntime().callStats(callId),
  };
}

/** The call's record name for Nova's instructions: the initiative's name, or null. */
async function recordNameOf(initiativeId: string | null): Promise<string | null> {
  if (!initiativeId) return null;
  try { return (await getProject(initiativeId))?.name ?? null; } catch { return null; }
}

/** Start (or restart) the live session for a record that already exists. */
async function startSession(callId: string, record: AssistantRecord, session: Session): Promise<void> {
  const names = await Promise.all([...new Set([...record.presentAtInvite, session.sub])].map((u) => nameOf(u)));
  await assistantRuntime().start({ callId, tenant: record.tenant, inviterId: record.invitedBy, roster: names, recordName: await recordNameOf(record.initiativeId) });
}

/** Arm the media server's tap for a call that is listening now. A failure here never undoes the listening: the call chat says so when the tap cannot be made. */
async function armAudio(callId: string, pre: Preflight | null): Promise<void> {
  if (!pre) return;
  // The channel goes on the record first, so a later boot can delete a tap this process leaves behind (audit M5).
  if (pre.channelArn) await assistantStore().patchSession(callId, { channelArn: pre.channelArn }).catch(() => null);
  try { await tapArmer().arm(callId, pre.channelArn); } catch (e) { console.warn('[meeting-assistant] arming the audio failed', (e as Error).message); }
}

const noteSeat = async (callId: string, session: Session) => { await assistantStore().attend(callId, session.sub); };

meetingAssistantRouter.post('/invite', requireAction('InviteMeetingAssistant'), asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const store = assistantStore();
  const startListening = () => {
    try { assistantIntake().start(callId); } catch (e) {
      if (e instanceof TranscriptSourceNotConfigured) throw new AppError(503, 'Live transcripts are not configured for this deployment');
      throw e;
    }
  };
  const existing = await store.get(callId);
  if (existing?.state === 'left') throw new AppError(409, 'The assistant already left this call');
  if (existing) {
    startListening(); await noteSeat(callId, session);
    // After a restart a listening record has no live session in this process: start one again on a repeated invite.
    if (existing.state === 'listening' && !assistantRuntime().isRunning(callId)) {
      const pre = await preflightAudio(session, callId, existing.lobby);
      const started = await startSession(callId, existing, session).then(() => true, () => false);
      if (started) await armAudio(callId, pre);
    }
    res.json(await view((await store.get(callId)) ?? existing, callId, session)); return;
  }
  if (!sessionAvailable()) throw new AppError(503, 'The live assistant is not configured for this deployment');

  const runtime = callChatRuntime();
  const lobby = await runtime.lobbyOf(callId);
  if (!lobby) throw new NotFoundError('Call is no longer active');
  const present = (await runtime.seatedUsers(callId)).filter((u) => u.active).map((u) => u.userId);
  if (!present.includes(session.sub)) present.push(session.sub);
  // Real audio: the three media settings and the call's channel, found by the server from the call, or a 503 here and nothing started.
  const pre = await preflightAudio(session, callId, lobby);
  startListening();
  // Money first (decision 10): the ceiling's minutes are held against the inviter. A refusal ends the invite here, in the shape
  // the voice mint gives, and Nova never joins.
  const initiativeId = initiativeOfLobby(lobby);
  const ceilingSeconds = assistantLimits().maxSeconds;
  const spend = assistantSpend();
  const held = await spend.reserve({
    callId, tenant: session.tenant, inviterId: session.sub, initiativeId, seconds: ceilingSeconds, part: 0,
    ...((req.body as { confirmOverUserBudget?: unknown } | undefined)?.confirmOverUserBudget === true ? { confirmOverUserBudget: true } : {}),
  });
  if (!held.ok) {
    assistantIntake().stop(callId);
    if (held.refusal.headers) res.set(held.refusal.headers);
    res.status(held.refusal.status).json(held.refusal.body);
    return;
  }
  const names = await Promise.all([...new Set(present)].map((u) => nameOf(u)));
  const startCtx: StartContext = { callId, tenant: session.tenant, inviterId: session.sub, roster: names, recordName: await recordNameOf(initiativeId) };
  const giveBack = async () => { assistantIntake().stop(callId); await spend.release(held.holdId ? [held.holdId] : []); };
  try { await assistantRuntime().start(startCtx); } catch (e) {
    await giveBack();
    console.warn('[meeting-assistant] the live session did not start', (e as Error).message);
    throw new AppError(503, 'The live assistant could not start. Try again shortly.');
  }
  // `invited` is the moment of the invite; the inviter acknowledges by inviting, so listening starts at once.
  const invitedAt = assistantRuntime().deps.clock();
  let created: Awaited<ReturnType<typeof store.create>>;
  try {
    created = await store.create({
      callId, tenant: session.tenant, lobby, initiativeId, state: 'invited',
      invitedBy: session.sub, invitedAt, pausedBy: null, leftAt: null, leftBy: null,
      acked: [session.sub], attendees: [...new Set(present)], presentAtInvite: [...new Set(present)],
      requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [],
      session: { ...newAssistantSession(ceilingSeconds), listeningSince: invitedAt },
    });
  } catch (e) { await assistantRuntime().stop(callId); await giveBack(); throw e; }
  const { record } = created;
  if (!created.created) {
    // Two invites at once: the other request wrote the record first. This request's hold is a second one for the same call, so it goes back,
    // no second notice is posted, and the caller gets the record that exists (the other request arms the audio).
    await spend.release(held.holdId ? [held.holdId] : []);
    res.json(await view(record, callId, session));
    return;
  }
  const listening = await store.transition(callId, { from: ['invited'], to: 'listening', by: session.sub, at: Date.now() });
  await armAudio(callId, pre);
  await postNoticeQuietly(callId, noticeText.joined(await nameOf(session.sub, session.name), config.meetingAssistant.transcriptRetentionDays));
  res.status(201).json(await view(listening ?? record, callId, session));
}));

/** Shared by pause, resume and dismiss: do the move, or say why not. A repeat of the state you are already in is a success. */
function move(to: 'paused' | 'listening' | 'left', from: AssistantRecord['state'][]) {
  return asyncHandler(async (req, res) => {
    const { session, callId } = await seatOf(req);
    const store = assistantStore();
    await noteSeat(callId, session);
    const before = await store.get(callId);
    if (to === 'listening' && before?.state === 'paused' && !sessionAvailable()) throw new AppError(503, 'The live assistant is not configured for this deployment');
    // Resuming listens again: a new token and a new tap, so the channel is looked up again first (503, still paused, when it cannot be).
    const pre = to === 'listening' && before?.state === 'paused' ? await preflightAudio(session, callId, before.lobby) : null;
    // Leaving: whoever holds a seat right now was there while Nova was (read before the record becomes `left`, which closes attendance).
    if (to === 'left') for (const u of await callChatRuntime().seatedUsers(callId).catch(() => [])) if (u.active) await store.attend(callId, u.userId);
    // A resume after a settlement (the reconcile after a restart booked the spend and released the hold) starts a fresh period: a fresh
    // hold first, so a refusal ends the resume here with the record still paused (audit M5).
    let fresh: { holdId: string | null; patch: Partial<AssistantSession> } | null = null;
    if (to === 'listening' && before?.state === 'paused' && recordSession(before).settled) {
      const prior = recordSession(before); const limits = assistantLimits();
      const part = Math.max(prior.extensions, prior.ledgerPart ?? 0) + 1;
      const held = await assistantSpend().reserve({ callId, tenant: before.tenant, inviterId: before.invitedBy, initiativeId: before.initiativeId, seconds: limits.maxSeconds, part });
      if (!held.ok) { if (held.refusal.headers) res.set(held.refusal.headers); res.status(held.refusal.status).json(held.refusal.body); return; }
      fresh = { holdId: held.holdId, patch: {
        settled: false, ledgerPart: part, extensions: part, holds: [], listeningSeconds: 0, listeningSince: null, limitNoticed: false,
        // The ceiling counts the whole call: what was settled stays on the clock, so a restart does not buy a second full period.
        settledListeningSeconds: prior.settledListeningSeconds + prior.listeningSeconds, ceilingSeconds: prior.ceilingSeconds, warned: prior.warned,
        replacements: 0, usageSeconds: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0,
      } };
    }
    const giveBackFresh = async () => { if (fresh) await assistantSpend().release(fresh.holdId ? [fresh.holdId] : []); };
    const done = await store.transition(callId, { from, to, by: session.sub, at: Date.now() });
    if (!done) await giveBackFresh();
    if (done) {
      const runtime = assistantRuntime();
      if (to === 'paused') await runtime.pause(callId);
      if (to === 'listening') {
        try {
          if (fresh) await store.patchSession(callId, fresh.patch);
          // After a restart nothing in this process is hearing the call's captions: start the intake again (a no-op when it is running).
          try { assistantIntake().start(callId); } catch (e) { if (e instanceof TranscriptSourceNotConfigured) throw new AppError(503, 'Live transcripts are not configured for this deployment'); throw e; }
          if (runtime.isRunning(callId)) await runtime.resume(callId); else await startSession(callId, (await store.get(callId)) ?? done, session);
        } catch (e) {
          // No session to listen with: back to paused, and say so. A fresh hold is given back and the period stays settled.
          await giveBackFresh();
          if (fresh) await store.patchSession(callId, { settled: true }).catch(() => null);
          await store.transition(callId, { from: ['listening'], to: 'paused', by: session.sub, at: Date.now() });
          if (e instanceof AppError) throw e;
          console.warn('[meeting-assistant] resume failed', (e as Error).message);
          throw new AppError(503, 'The live assistant could not start. Try again shortly.');
        }
        await armAudio(callId, pre);
      }
      const who = await nameOf(session.sub, session.name);
      if (to === 'paused') await postNoticeQuietly(callId, noticeText.paused(who));
      if (to === 'listening') await postNoticeQuietly(callId, noticeText.resumed(who));
      if (to === 'left') await postNoticeQuietly(callId, noticeText.dismissed(who, done.linesStored === 0), { leaving: true });
      if (to === 'left') {
        assistantIntake().stop(callId);
        await assistantRuntime().stop(callId);
        assistantAudio().forget(callId);
      }
      res.json(await view(await store.get(callId), callId, session));
      return;
    }
    const current = await store.get(callId);
    if (!current) throw new NotFoundError('The assistant is not in this call');
    if (current.state === to) { res.json(await view(current, callId, session)); return; }
    throw new AppError(409, `The assistant is ${current.state}; it cannot ${to === 'left' ? 'be dismissed' : to === 'paused' ? 'pause' : 'resume'} now`);
  });
}
meetingAssistantRouter.post('/pause', move('paused', ['listening']));
meetingAssistantRouter.post('/resume', move('listening', ['paused']));
meetingAssistantRouter.post('/dismiss', move('left', ['invited', 'listening', 'paused']));

meetingAssistantRouter.post('/ack', asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const store = assistantStore();
  const current = await store.get(callId);
  if (!current) throw new NotFoundError('The assistant is not in this call');
  if (current.state === 'left') throw new AppError(409, 'The assistant already left this call');
  const acked = await store.ack(callId, session.sub);
  await assistantAudio().refresh(callId); // this person's audio is admitted from now on, not at the next gate refresh
  res.json(await view(acked, callId, session));
}));

/** Nova speaking aloud is a per-call switch (decision 4), off until someone with the invite right turns it on; the call is told either way. */
meetingAssistantRouter.post('/voice', requireAction('InviteMeetingAssistant'), asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const on = (req.body as { on?: unknown } | undefined)?.on;
  if (typeof on !== 'boolean') throw new ValidationError('on must be true or false');
  const store = assistantStore();
  const current = await store.get(callId);
  if (!current) throw new NotFoundError('The assistant is not in this call');
  if (current.state === 'left') throw new AppError(409, 'The assistant already left this call');
  if (current.voice === true === on) { res.json(await view(current, callId, session)); return; }
  const updated = await store.setVoice(callId, on);
  if (!updated) throw new NotFoundError('The assistant is not in this call');
  assistantRuntime().setVoice(callId, on);
  const who = await nameOf(session.sub, session.name);
  await postNoticeQuietly(callId, on ? noticeText.voiceOn(who) : noticeText.voiceOff(who));
  res.json(await view(updated, callId, session));
}));

/**
 * A person binds their own media participant id (decision 8: audio is mixed in only for people who have acknowledged, and the
 * taps name participants, not people). The media server mints the id as `${userId}-${Date.now().toString(36)}` from the same `sub`
 * platform-api passes at join (and the call-binding proof pins to this session's `sub`), so the id must start with the caller's
 * own `sub` and a base36 stamp; nobody can claim another person's id, and an id already bound to someone else is refused.
 */
const PARTICIPANT_STAMP = /^[0-9a-z]{1,16}$/;
meetingAssistantRouter.post('/participant', asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const id = (req.body as { participantId?: unknown } | undefined)?.participantId;
  if (typeof id !== 'string' || id.length < 3 || id.length > 256) throw new ValidationError('participantId must be a string');
  const prefix = `${session.sub}-`;
  if (!id.startsWith(prefix) || !PARTICIPANT_STAMP.test(id.slice(prefix.length))) throw new AppError(403, 'You can only bind your own media participant id');
  const record = await assistantStore().get(callId);
  if (!record) throw new NotFoundError('The assistant is not in this call');
  if (record.state === 'left') throw new AppError(409, 'The assistant already left this call');
  const out = await assistantAudio().bindParticipant(callId, id, session.sub);
  if (out === 'taken') throw new AppError(409, 'That media participant id is already bound to someone else');
  if (out === 'too-many') throw new AppError(409, 'Too many media participant ids are bound for this call');
  res.json({ callId, participantId: id, bound: true });
}));

/** Anyone who may invite Nova may extend her time (decision 10): the default minutes, once per request, up to the hard maximum. */
meetingAssistantRouter.post('/extend', requireAction('InviteMeetingAssistant'), asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  await noteSeat(callId, session);
  const out = await assistantRuntime().extend(callId, session, (req.body as { confirmOverUserBudget?: unknown } | undefined)?.confirmOverUserBudget === true);
  if (out.ok) { res.json(await view(await assistantStore().get(callId), callId, session)); return; }
  if (out.why === 'refused') {
    if (out.refusal.headers) res.set(out.refusal.headers);
    res.status(out.refusal.status).json(out.refusal.body);
    return;
  }
  if (out.why === 'no-assistant') throw new NotFoundError('The assistant is not in this call');
  if (out.why === 'left') throw new AppError(409, 'The assistant already left this call');
  throw new AppError(409, `This call is already at its longest (${Math.round(assistantLimits().hardMaxSeconds / 60)} minutes)`);
}));

/** Only the person an action was offered to decides it (decision 5). Everyone else, and anyone with no such action: no. */
meetingAssistantRouter.post('/actions/:actionId/decision', asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const actionId = req.params['actionId'];
  if (typeof actionId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(actionId)) throw new ValidationError('Invalid action id');
  const decision = (req.body as { decision?: unknown } | undefined)?.decision;
  if (decision !== 'confirm' && decision !== 'decline') throw new ValidationError("decision must be 'confirm' or 'decline'");
  const store = assistantStore();
  const record = await store.get(callId);
  if (!record) throw new NotFoundError('The assistant is not in this call');
  // The minutes' "Create a work item" cards (ids `m-...`) are offered after the assistant has left; every other card ends with it.
  if (record.state === 'left' && !actionId.startsWith('m-')) throw new AppError(409, 'The assistant already left this call');
  const action = await store.getAction(callId, actionId);
  if (!action) throw new NotFoundError('No such action');
  if (action.askedBy !== session.sub) throw new AppError(403, 'Only the person who asked can decide this action');
  const to = decision === 'confirm' ? 'confirmed' : 'declined';
  const moved = await moveAction(callId, actionId, { from: ['waiting'], to, by: session.sub });
  if (!moved) {
    // Already decided: the same decision again is a success, a different one is a conflict.
    if (action.status === to) { res.json({ actionId, status: action.status, decidedBy: action.decidedBy, decidedAt: action.decidedAt }); return; }
    throw new AppError(409, `This action is already ${action.status}`);
  }
  await assistantRuntime().onDecision(callId, actionId, decision);
  res.json({ actionId, status: moved.status, decidedBy: moved.decidedBy, decidedAt: moved.decidedAt });
}));

/** The turns waiting for MY browser. Never anyone else's: the list is filtered by the caller's own id. */
meetingAssistantRouter.get('/turns', asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const turns = await assistantRuntime().turnsFor(callId, session.sub);
  res.json({ callId, turns: turns.map((t) => ({ turnId: t.turnId, kind: t.kind, status: t.status, tool: t.tool, actionId: t.actionId ?? null, createdAt: t.createdAt, expiresAt: t.expiresAt })) });
}));

const turnIdOf = (req: Request): string => {
  const id = req.params['turnId'];
  if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(id)) throw new NotFoundError('No such turn');
  return id;
};

/**
 * A browser claims a turn before running it (audit B6). Only the asker; anyone else, and an unknown turn, get the same 404.
 * Answers { turnId, claimId, tool: { name, args }, kind }; a second claim, an expired or not-yet-runnable turn answers 409.
 */
meetingAssistantRouter.post('/turns/:turnId/claim', asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const turnId = turnIdOf(req);
  const out = await assistantRuntime().claimTurn(callId, turnId, session.sub);
  if (!out) throw new NotFoundError('No such turn');
  if ('conflict' in out) throw new AppError(409, `This turn cannot be claimed: ${out.conflict}`);
  // `expiresAt` is the turn's expiry after the claim (a claimed write is given time to finish), so a late write keeps its result.
  res.json({ turnId, claimId: out.turn.claimId, tool: out.turn.tool, kind: out.turn.kind, expiresAt: out.turn.expiresAt });
}));

/** The browser's result of a turn, with the claim id its claim returned (400 without it, 409 when it is not the claim). A caller who is not the asker, or an unknown turn, gets the 404. */
meetingAssistantRouter.post('/turns/:turnId/result', asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const turnId = turnIdOf(req);
  const body = (req.body ?? {}) as { ok?: unknown; claimId?: unknown; output?: unknown; error?: unknown };
  if (typeof body.ok !== 'boolean') throw new ValidationError('ok must be true or false');
  if (typeof body.claimId !== 'string' || !/^[0-9a-f]{8,64}$/.test(body.claimId)) throw new ValidationError('claimId is required: claim the turn first');
  if (body.error !== undefined && typeof body.error !== 'string') throw new ValidationError('error must be a string');
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(body.output ?? null)); } catch { throw new ValidationError('output must be JSON'); }
  if (size > MAX_RESULT_BYTES) throw new AppError(413, `output may be at most ${MAX_RESULT_BYTES} bytes`);
  const out = await assistantRuntime().submitResult(callId, turnId, session.sub, { ok: body.ok, claimId: body.claimId, output: body.output, ...(typeof body.error === 'string' ? { error: body.error } : {}) });
  if (!out) throw new NotFoundError('No such turn');
  if ('conflict' in out) throw new AppError(409, `This turn is ${out.conflict}`);
  res.json({ turnId, status: out.turn.status });
}));

meetingAssistantRouter.get('/state', asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const store = assistantStore();
  await noteSeat(callId, session);
  res.json(await view(await store.get(callId), callId, session));
}));

/** `?after=<seq>&limit=<1..500>`; digits only, so nothing odd reaches the store. */
function intParam(raw: unknown, name: string, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new ValidationError(`${name} must be between ${min} and ${max}`);
  return Number(raw);
}

/**
 * THE attendee rule, applied by every read of a call's words (transcript and minutes; the meeting list asks the store for
 * the same test): the assistant has a record for this call in the caller's tenant, and the caller held an ACTIVE seat at some
 * moment between the invite and the assistant leaving (recorded as it happens; nothing is inferred from a seat read afterwards). Same answer for "no assistant", "another tenant's call" and "you were not there": 404.
 * Admins get no exception.
 */
export async function attendeeOf(session: Session, callId: string): Promise<AssistantRecord> {
  const record = await assistantStore().get(callId);
  if (!record || record.tenant !== session.tenant || !record.attendees.includes(session.sub)) throw new NotFoundError('Not found');
  return record;
}

/** A deleted record is gone for everyone, its transcript included. */
async function liveRecordOf(session: Session, callId: string): Promise<AssistantRecord> {
  const record = await attendeeOf(session, callId);
  if ((await assistantStore().getMinutes(callId))?.deleted) throw new NotFoundError('Not found');
  return record;
}

meetingAssistantRouter.get('/transcript', asyncHandler(async (req, res) => {
  const session = sessionOf(req); const callId = callIdOf(req);
  const after = intParam(req.query['after'], 'after', 0, 1_000_000_000, 0);
  const limit = intParam(req.query['limit'], 'limit', 1, 500, 100);
  await liveRecordOf(session, callId);
  const lines = await assistantStore().lines(callId, after, limit);
  res.json({ callId, after, lines, next: lines.length ? lines[lines.length - 1]!.seq : after });
}));

/** Notes and transcript are personal data: reading them is attributed to the person who was there, so no masquerade. */
function refuseMasqueradeRead(req: Request, res: Response, next: NextFunction): void {
  if (resolveSession(req)?.act) { res.status(403).json({ error: 'stop masquerading to read meeting records; they belong to the people who were there', code: 'MASQUERADING' }); return; }
  next();
}

async function namesOf(ids: readonly string[]): Promise<Array<{ userId: string; name: string }>> {
  return Promise.all(ids.map(async (userId) => ({ userId, name: await nameOf(userId) })));
}

meetingAssistantRouter.get('/minutes', refuseMasqueradeRead, asyncHandler(async (req, res) => {
  const session = sessionOf(req); const callId = callIdOf(req);
  await liveRecordOf(session, callId);
  const m = await assistantStore().getMinutes(callId);
  if (!m || m.deleted) throw new NotFoundError('No minutes');
  res.json({
    callId, callName: m.callName, lobby: m.lobby, initiativeId: m.initiativeId, startedAt: m.startedAt, endedAt: m.endedAt,
    invitedBy: m.invitedBy, invitedByName: await nameOf(m.invitedBy), attendees: await namesOf(m.attendees), summary: m.summary, decisions: m.decisions,
    actionItems: m.actionItems, topics: m.topics, lineCount: m.lineCount, truncated: m.truncated, writer: m.writer, createdAt: m.createdAt,
    youAreInviter: m.invitedBy === session.sub,
  });
}));

/** The inviter's delete: minutes and transcript go, a tombstone stays. A second delete is a 404, like everyone else's. */
const deleteRecord = asyncHandler(async (req, res) => {
  const session = sessionOf(req); const callId = callIdOf(req);
  const record = await liveRecordOf(session, callId);
  if (record.invitedBy !== session.sub) throw new AppError(403, 'Only the person who invited the assistant can delete this record');
  if (record.state !== 'left') throw new AppError(409, 'Dismiss the assistant before deleting its record');
  const lines = await eraseCall(assistantStore(), callId, session.sub, Date.now());
  res.json({ callId, deleted: true, linesRemoved: lines });
});
meetingAssistantRouter.delete('/minutes', refuseMasqueradeRead, deleteRecord);
meetingAssistantRouter.delete('/transcript', refuseMasqueradeRead, deleteRecord);

// The call ended with the assistant still in it: it leaves with the call and the minutes are written. One subscription per process.
let watchingCallEnd = false;
function watchCallEnd(): void {
  if (watchingCallEnd) return;
  watchingCallEnd = true;
  onCallChatFinished((callId, seated) => trackMinutes((async () => {
    if (!meetingAssistantEnabled()) return;
    const store = assistantStore();
    if (!(await store.get(callId))) return;
    for (const userId of seated) await store.attend(callId, userId);
    await onCallEnded(callId, { stop: (id) => assistantRuntime().stop(id), stopIntake: (id) => assistantIntake().stop(id) });
  })()));
}
watchCallEnd();

/** `GET /api/meetings`: the meetings the caller attended with the assistant present, newest first. Never anyone else's. */
export const meetingsRouter = Router();
meetingsRouter.use(flagGate, requireTenant('orgiq'), refuseMasqueradeRead);
meetingsRouter.get('/', asyncHandler(async (req, res) => {
  const session = sessionOf(req);
  const limit = intParam(req.query['limit'], 'limit', 1, 100, 25);
  const rawBefore = req.query['before'];
  if (rawBefore !== undefined && (typeof rawBefore !== 'string' || !/^\d{1,14}$/.test(rawBefore) || Number(rawBefore) < 1)) throw new ValidationError('before must be an epoch in milliseconds');
  const before = rawBefore === undefined ? undefined : Number(rawBefore);
  const initiative = req.query['initiative'];
  if (initiative !== undefined && (typeof initiative !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(initiative))) throw new ValidationError('Invalid initiative');
  const rows = await assistantStore().listMinutes({ tenant: session.tenant, userId: session.sub, limit, ...(initiative ? { initiativeId: initiative } : {}), ...(before ? { before } : {}) });
  const meetings = await Promise.all(rows.map(async (m) => ({
    callId: m.callId, callName: m.callName, lobby: m.lobby, initiativeId: m.initiativeId, startedAt: m.startedAt, endedAt: m.endedAt,
    attendees: (await namesOf(m.attendees)).map((a) => a.name), summary: m.summary, decisionCount: m.decisions.length, actionItemCount: m.actionItems.length,
  })));
  res.json({ meetings, next: rows.length === limit ? rows[rows.length - 1]!.endedAt : null });
}));
