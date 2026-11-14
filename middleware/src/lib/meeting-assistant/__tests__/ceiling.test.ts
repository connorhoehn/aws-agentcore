// The listening ceiling, its warning, extension, the per-call request cap and the settlement (package 4a, decision 10).
// The clock is a variable; nothing sleeps. Spend is a recorder: the real holds and ledger are covered by
// routes/__tests__/meeting-assistant-spend.test.ts.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
const mockPosts = { replies: [] as string[], notices: [] as string[] };
jest.mock('../chat.js', () => ({
  nameOf: async (id: string) => ({ 'u-alice': 'Alice', 'u-bob': 'Bob' } as Record<string, string>)[id] ?? id,
  postReply: async (_c: string, r: { text: string }) => { mockPosts.replies.push(r.text); return { id: 'm' }; },
  postPrivately: async () => true,
  postNoticeQuietly: async (_c: string, text: string) => { mockPosts.notices.push(text); },
  postAction: async () => ({ message: { id: 'm' }, created: true }),
  moveAction: async () => null,
}));
jest.mock('../../call-chat.js', () => ({ callChatRuntime: () => ({ seatedUsers: async () => [{ userId: 'u-alice', active: true }] }) }));

import { LineIntake } from '../intake.js';
import { MemoryAssistantStore } from '../store.js';
import { MockTranscriptSource } from '../transcript-source.js';
import { AssistantRuntime } from '../orchestrator.js';
import { ScriptedSession } from '../scripted-session.js';
import { setAssistantStore } from '../store-select.js';
import { assistantLimits } from '../limits.js';
import { listeningSecondsOf, setAssistantSpend, settleFinished, sourceIdFor, type AssistantSpend, type ReserveInput, type SettleInput } from '../spend.js';
import { newAssistantSession, sessionOf } from '../types.js';

const CALL = 'call-1'; const ALICE = 'u-alice';
const T0 = Date.parse('2026-11-13T12:00:00.000Z');
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise<void>((r) => setImmediate(r)); };
const ENV = ['MEETING_ASSISTANT_MAX_MINUTES', 'MEETING_ASSISTANT_HARD_MAX_MINUTES', 'MEETING_ASSISTANT_MAX_REQUESTS'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

let now: number; let store: MemoryAssistantStore; let intake: LineIntake; let runtime: AssistantRuntime;
let reserved: ReserveInput[]; let released: string[][]; let settled: SettleInput[]; let reserveResult: 'ok' | 'refuse'; let settleFails: boolean;
const spend: AssistantSpend = {
  async reserve(i) { reserved.push(i); return reserveResult === 'ok' ? { ok: true, holdId: `hold-${i.part}` } : { ok: false, refusal: { status: 403, body: { error: 'over budget', reason: 'budget' } } }; },
  async release(ids) { released.push([...ids]); },
  async settle(i) { if (settleFails) throw new Error('ledger down'); settled.push(i); },
};

beforeEach(async () => {
  for (const k of ENV) delete process.env[k];
  process.env['MEETING_ASSISTANT_MAX_MINUTES'] = '10'; process.env['MEETING_ASSISTANT_HARD_MAX_MINUTES'] = '25';
  now = T0; mockPosts.replies.length = 0; mockPosts.notices.length = 0;
  reserved = []; released = []; settled = []; reserveResult = 'ok'; settleFails = false;
  setAssistantSpend(spend);
  store = new MemoryAssistantStore(); setAssistantStore(store);
  const source = new MockTranscriptSource();
  intake = new LineIntake(store, { clock: () => now, tickMs: 0, source: () => source });
  intake.start(CALL);
  runtime = new AssistantRuntime({ store: () => store, intake: () => intake, clock: () => now, makeSession: () => new ScriptedSession(() => now),
    rolesOf: async () => ['member'], onFinished: (e) => settleFinished(e, now) }, { tickMs: 0 });
  await store.create({
    callId: CALL, tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth', initiativeId: 'p-auth', state: 'listening', invitedBy: ALICE, invitedAt: now,
    pausedBy: null, leftAt: null, leftBy: null, acked: [ALICE], attendees: [ALICE], presentAtInvite: [ALICE], requests: 0, linesStored: 0, nextSeq: 1,
    pendingRequests: [], session: { ...newAssistantSession(assistantLimits().maxSeconds), holds: [] },
  });
  await runtime.start({ callId: CALL, tenant: 'orgiq', inviterId: ALICE, roster: ['Alice'], recordName: null });
});
afterEach(async () => {
  await runtime.dispose(); intake.dispose(); setAssistantStore(null); setAssistantSpend(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const advance = async (seconds: number) => { now += seconds * 1000; await runtime.tick(); await flush(); };
const rec = async () => (await store.get(CALL))!;

describe('the limits', () => {
  it('read the environment on every call, with the documented defaults and a hard maximum never below the first ceiling', () => {
    for (const k of ENV) delete process.env[k];
    expect(assistantLimits()).toEqual({ maxSeconds: 3600, hardMaxSeconds: 10_800, maxRequests: 60 });
    process.env['MEETING_ASSISTANT_MAX_MINUTES'] = '90'; process.env['MEETING_ASSISTANT_HARD_MAX_MINUTES'] = '30';
    expect(assistantLimits().hardMaxSeconds).toBe(5400);
    process.env['MEETING_ASSISTANT_MAX_MINUTES'] = 'nope';
    expect(assistantLimits().maxSeconds).toBe(3600);
  });
});

describe('the ceiling', () => {
  it('starts counting when Nova starts listening and exposes the seconds', async () => {
    expect(sessionOf(await rec()).listeningSince).toBe(T0);
    now += 42_000;
    expect(listeningSecondsOf(await rec(), now)).toBe(42);
  });

  it('warns once five minutes before the ceiling and leaves at the ceiling with a notice, settling the spend once', async () => {
    await advance(200);
    expect(mockPosts.notices).toEqual([]);
    await advance(101);                                  // 301 s of a 600 s ceiling: 299 s left
    expect(mockPosts.notices).toEqual(['Nova leaves in 5 minutes. Anyone who can invite Nova can extend.']);
    await advance(100); await advance(100);              // still warned once
    expect(mockPosts.notices).toHaveLength(1);
    await advance(100);                                  // 601 s
    expect((await rec()).state).toBe('left');
    expect(mockPosts.notices[1]).toMatch(/Nova left because this call reached its 10-minute limit/);
    expect(mockPosts.notices[1]).not.toMatch(/again/);
    expect(runtime.isRunning(CALL)).toBe(false);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ usageSeconds: 601, sessionKind: 'scripted', listeningSeconds: 601, record: { callId: CALL, invitedBy: ALICE, initiativeId: 'p-auth' } });
    await runtime.tick();
    expect(settled).toHaveLength(1);
  });

  it('does not count time while paused', async () => {
    await advance(100);
    await runtime.pause(CALL);
    expect(sessionOf(await rec()).listeningSeconds).toBe(100);
    await advance(3 * 3600);
    expect((await rec()).state).toBe('listening');       // the store's state is the route's; the ceiling only watches a listening record
    await runtime.resume(CALL);
    await advance(450);                                  // 550 s of 600 s: warning, not leaving
    expect(mockPosts.notices).toEqual(['Nova leaves in 5 minutes. Anyone who can invite Nova can extend.']);
    expect(runtime.isRunning(CALL)).toBe(true);
  });

  it('a lone ceiling shorter than the warning warns at once', async () => {
    await store.patchSession(CALL, { ceilingSeconds: 120 });
    await advance(1);
    expect(mockPosts.notices).toHaveLength(1);
  });
});

describe('extension', () => {
  it('two extensions at once keep both hold ids', async () => {
    const slow = jest.spyOn(spend, 'reserve').mockImplementation(async (i) => { await new Promise<void>((r) => setImmediate(r)); reserved.push(i); return { ok: true, holdId: `hold-${i.part}` }; });
    const [a, b] = await Promise.all([runtime.extend(CALL, { sub: ALICE }), runtime.extend(CALL, { sub: ALICE })]);
    slow.mockRestore();
    expect(a).toMatchObject({ ok: true }); expect(b).toMatchObject({ ok: true });
    expect(sessionOf(await rec())).toMatchObject({ holds: ['hold-1', 'hold-2'], extensions: 2 });
  });

  it('adds the default minutes up to the hard maximum, holds the money each time, and re-arms the warning', async () => {
    await advance(400);
    expect(mockPosts.notices).toHaveLength(1);
    const first = await runtime.extend(CALL, { sub: ALICE });
    expect(first).toEqual({ ok: true, ceilingSeconds: 1200, addedSeconds: 600 });
    expect(reserved[0]).toMatchObject({ callId: CALL, inviterId: ALICE, initiativeId: 'p-auth', seconds: 600, part: 1 });
    expect(sourceIdFor(CALL, 1)).toBe('ma:call-1:x1');
    expect(sessionOf(await rec())).toMatchObject({ ceilingSeconds: 1200, warned: false, holds: ['hold-1'], extensions: 1 });
    expect(mockPosts.notices.at(-1)).toBe("Alice extended Nova's time by 10 minutes.");
    const second = await runtime.extend(CALL, { sub: ALICE });
    expect(second).toEqual({ ok: true, ceilingSeconds: 1500, addedSeconds: 300 });  // capped at 25 minutes
    expect(reserved[1]).toMatchObject({ seconds: 300, part: 2 });
    expect(await runtime.extend(CALL, { sub: ALICE })).toEqual({ ok: false, why: 'at-maximum' });
    expect(reserved).toHaveLength(2);
    await advance(300);                                  // 700 s of 1500: not leaving
    expect(runtime.isRunning(CALL)).toBe(true);
  });

  it('a refused hold changes nothing and hands back the refusal; a call that left or never was cannot be extended', async () => {
    reserveResult = 'refuse';
    const out = await runtime.extend(CALL, { sub: ALICE });
    expect(out).toMatchObject({ ok: false, why: 'refused', refusal: { status: 403, body: { reason: 'budget' } } });
    expect(sessionOf(await rec()).ceilingSeconds).toBe(600);
    expect(await runtime.extend('nope', { sub: ALICE })).toEqual({ ok: false, why: 'no-assistant' });
    await store.transition(CALL, { from: ['listening'], to: 'left', by: ALICE, at: now });
    expect(await runtime.extend(CALL, { sub: ALICE })).toEqual({ ok: false, why: 'left' });
  });
});

describe('the request cap', () => {
  it('past the cap Nova says so once and ignores further requests', async () => {
    process.env['MEETING_ASSISTANT_MAX_REQUESTS'] = '2';
    const ask = async (text: string) => { await intake.handle(CALL, { userId: ALICE, text, at: now }); now += 5000; await intake.tick(); await flush(); };
    await ask('Nova, what is two plus two?');
    await ask('Nova, what is two plus two?');
    expect(mockPosts.replies).toEqual(['Four.', 'Four.']);
    await ask('Nova, what is two plus two?');
    await ask('Nova, what is two plus two?');
    expect(mockPosts.replies).toEqual(['Four.', 'Four.']);
    expect(mockPosts.notices.filter((n) => /reached its limit of 2 requests/.test(n))).toHaveLength(1);
    expect(sessionOf(await rec()).limitNoticed).toBe(true);
  });
});

describe('settlement', () => {
  it('books once when Nova leaves: the session seconds, the listening seconds and the extension holds released', async () => {
    await advance(30);
    await runtime.extend(CALL, { sub: ALICE });
    await advance(30);
    await runtime.stop(CALL); await runtime.stop(CALL);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ usageSeconds: 60, listeningSeconds: 60, tokens: { input: 0, output: 0, cached: 0 } });
    expect(released).toEqual([['hold-1']]);
    expect(sessionOf(await rec()).settled).toBe(true);
    await settleFinished({ callId: CALL, usageSeconds: 60, tokens: { input: 0, output: 0, cached: 0 }, sessionKind: 'scripted' }, now);
    expect(settled).toHaveLength(1);
  });

  it('a failed ledger write is not marked settled, so the next stop may try again', async () => {
    settleFails = true;
    await runtime.stop(CALL);
    expect(sessionOf(await rec()).settled).toBe(false);
    settleFails = false;
    await settleFinished({ callId: CALL, usageSeconds: 5, tokens: { input: 0, output: 0, cached: 0 }, sessionKind: 'scripted' }, now);
    expect(settled).toHaveLength(1);
  });
});
