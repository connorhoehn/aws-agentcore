// The live session, attribution, the name lock and turns, through the real routes and the real call chat (package 4a).
// Harness: routes/__tests__/meeting-assistant.test.ts. The session is the scripted one (the mock world), on a test clock.
const mockConfig = { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true },
  meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } };
jest.mock('../../config.js', () => ({ config: mockConfig }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/projects.js', () => ({ getProject: jest.fn() }));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn() }));
const mockInviters = new Set<string>();
jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session,
  isAllowed: jest.fn(async () => true),
  requireTenant: (tenant: string) => (req: { session?: { tenant: string; role: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (req.session?.tenant === tenant || req.session?.role === 'admin' ? next() : res.status(403).json({ error: 'Forbidden' })),
  requireAction: (action: string) => (req: { session?: { sub: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (action === 'InviteMeetingAssistant' && req.session && mockInviters.has(req.session.sub) ? next() : res.status(403).json({ error: 'Forbidden', action })),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { InMemoryCallStateStore } from '@connorhoehn/realtime-modules/call';
import { InMemoryChatStore } from '@connorhoehn/realtime-modules/chat';
import type { RealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { meetingAssistantRouter } from '../meeting-assistant.js';
import { meetingAssistantDevRouter } from '../meeting-assistant-dev.js';
import { errorHandler } from '../../lib/async-handler.js';
import { CallChatRuntime, callChatChannel, setCallChatRuntime } from '../../lib/call-chat.js';
import { MemoryCallChatStateStore } from '../../lib/call-chat-state.js';
import { observeCallPageLifecycle } from '../../lib/call-pages.js';
import { setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';
import { assistantStore, assistantIntake, setAssistantStore, setAssistantIntake, LineIntake, MemoryAssistantStore, setTranscriptSource, MockTranscriptSource } from '../../lib/meeting-assistant/index.js';
import { AssistantRuntime, setAssistantRuntime, defaultRolesOf } from '../../lib/meeting-assistant/orchestrator.js';
import { ScriptedSession } from '../../lib/meeting-assistant/scripted-session.js';
import { setSessionFactory } from '../../lib/meeting-assistant/session-select.js';
import { getUser } from '../../providers/identity.js';
import type { Session } from '../../lib/session.js';

const CALL = 'call-1'; const LOBBY = 'orgiq:dm:alice:bob:carol'; const CHANNEL = callChatChannel(CALL);
const NAMES: Record<string, string> = { alice: 'Alice Ames', bob: 'Bob Baker' };
const mk = (sub: string): Session => ({ sub, name: NAMES[sub] ?? sub, tenant: 'orgiq', role: 'member', epoch: 0, grants: { orgiq: ['member'], social: ['participant'] }, iat: 100 });
let sessions: Map<string, Session>; let contexts: Map<string, Record<string, unknown>>;
let calls: InMemoryCallStateStore; let rt: CallChatRuntime; let source: MockTranscriptSource; let clock: number; let chatStore: InMemoryChatStore;
let notified: Array<{ userId: string; input: NotificationInputLike }>;
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
app.use(meetingAssistantDevRouter);
app.use('/api/calls/:callId/assistant', meetingAssistantRouter); app.use(errorHandler);
const ctx = (s: Session) => ({ userId: s.sub, org: s.tenant, role: s.role, displayName: s.sub, epoch: s.epoch ?? 0, sessionIat: s.iat });
const url = (path: string) => `/api/calls/${CALL}/assistant/${path}`;
const post = (path: string, user = 'alice', body: object = {}) => request(app).post(url(path)).set('x-user', user).send(body);
const get = (path: string, user = 'alice') => request(app).get(url(path)).set('x-user', user);
const inject = (body: object) => request(app).post(`/api/dev/calls/${CALL}/transcript-lines`).send(body);
const devCall = (body: object) => request(app).post(`/api/dev/calls/${CALL}/assistant-tool-call`).send(body);
const chat = async () => (await chatStore.listMessages(CHANNEL, 100));
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setImmediate(r)); };
/** A spoken request, then the quiet that lets the detector close it. */
async function ask(user: string, text: string) {
  await inject({ userId: user, text, at: clock });
  clock += 5000;
  await assistantIntake().tick();
  await flush();
}
const novaMessages = async (kind: string) => (await chat()).filter((m) => (m.metadata as { kind?: string } | undefined)?.kind === kind);

beforeEach(async () => {
  clock = Date.parse('2026-11-13T12:00:00.000Z');
  mockConfig.meetingAssistant.enabled = true; mockConfig.mock.aurora = true;
  mockInviters.clear(); mockInviters.add('alice'); mockInviters.add('bob');
  const people = [mk('alice'), mk('bob'), mk('carol')];
  sessions = new Map(people.map((s) => [s.sub, s]));
  contexts = new Map([['a', ctx(mk('alice'))], ['b', ctx(mk('bob'))], ['c', ctx(mk('carol'))]]);
  jest.mocked(getUser).mockImplementation(async (id: string) => ({ id, displayName: NAMES[id] ?? id, email: null, personId: null, epoch: 0, grants: mk(id).grants }) as never);
  calls = new InMemoryCallStateStore(); chatStore = new InMemoryChatStore(); notified = [];
  setNotificationSink({ notifyUser: async (userId, input) => { notified.push({ userId, input }); } });
  const router = { sendToClient: jest.fn(), sendToChannel: jest.fn(), isClientLive: (id: string) => contexts.has(id), getClientData: (id: string) => ({ userContext: contexts.get(id) }), unsubscribeFromChannel: jest.fn() } as unknown as RealtimeRouter;
  rt = new CallChatRuntime({ calls, state: new MemoryCallChatStateStore(), messages: chatStore, router, maintenanceIntervalMs: 0, now: () => clock, lobbyAllowed: (_a, lobby) => lobby.startsWith('orgiq:') });
  setCallChatRuntime(rt);
  const observed = observeCallPageLifecycle(calls, () => null, () => rt);
  for (const [cid, u] of [['a', 'alice'], ['b', 'bob'], ['c', 'carol']] as const) await observed.registerParticipant(CALL, cid, u, LOBBY, ['alice', 'bob', 'carol']);
  setAssistantStore(new MemoryAssistantStore());
  source = new MockTranscriptSource(); setTranscriptSource(source);
  setAssistantIntake(new LineIntake(assistantStore(), { clock: () => clock, tickMs: 0, source: () => source }));
  setSessionFactory(() => new ScriptedSession(() => clock));
  setAssistantRuntime(new AssistantRuntime({ store: assistantStore, intake: assistantIntake, clock: () => clock, makeSession: () => new ScriptedSession(() => clock), rolesOf: defaultRolesOf }, { tickMs: 0 }));
});
afterEach(() => { setAssistantRuntime(null); setSessionFactory(null); setAssistantIntake(null); setAssistantStore(null); setTranscriptSource(null); setNotificationSink(null); rt.dispose(); setCallChatRuntime(null); });

describe('a read in the call chat', () => {
  it('"Nova, what is two plus two?" lands as a reply labelled with the asker', async () => {
    expect((await post('invite')).status).toBe(201);
    await ask('alice', 'Nova, what is two plus two?');
    const replies = await novaMessages('assistant-reply');
    expect(replies.map((m) => [m.message, (m.metadata as { askedBy: string; askedByName: string }).askedBy, (m.metadata as { askedByName: string }).askedByName])).toEqual([['Four.', 'alice', 'Alice Ames']]);
  });

  it('a search becomes a turn only the asker sees and can answer; the answer is shown by what Nova says, never the raw data', async () => {
    await post('invite'); await post('ack', 'bob');
    await ask('bob', 'Nova, find the Kubernetes experts');
    const mine = (await get('turns?mine=1', 'bob')).body.turns;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'read', status: 'pending', tool: { name: 'search', args: { query: 'the Kubernetes experts' } } });
    expect((await get('turns?mine=1', 'alice')).body.turns).toEqual([]);
    expect((await get('turns', 'alice')).body.turns).toEqual([]);
    const id = mine[0].turnId;
    expect((await post(`turns/${id}/claim`, 'alice')).status).toBe(404);
    expect((await post(`turns/${id}/claim`, 'carol')).status).toBe(404);
    expect((await post(`turns/${id}/result`, 'alice', { claimId: 'aaaaaaaaaaaaaaaa', ok: true, output: { rows: [] } })).status).toBe(404);
    expect((await post(`turns/${id}/result`, 'carol', { claimId: 'aaaaaaaaaaaaaaaa', ok: true, output: { rows: [] } })).status).toBe(404);
    const claimed = await post(`turns/${id}/claim`, 'bob');
    expect(claimed.status).toBe(200);
    expect(claimed.body).toEqual({ turnId: id, claimId: expect.stringMatching(/^[0-9a-f]{24}$/), tool: { name: 'search', args: { query: 'the Kubernetes experts' } }, kind: 'read', expiresAt: expect.any(Number) });
    const claimId = claimed.body.claimId;
    expect((await post(`turns/${id}/claim`, 'bob')).status).toBe(409);               // one claim per turn
    expect((await get('turns?mine=1', 'bob')).body.turns).toEqual([]);                // a claimed turn is not listed again
    expect((await post(`turns/${id}/result`, 'bob', { ok: true, output: {} })).status).toBe(400);                           // no claim id
    expect((await post(`turns/${id}/result`, 'bob', { claimId: 'bbbbbbbbbbbbbbbb', ok: true, output: {} })).status).toBe(409); // not the claim
    expect((await post(`turns/${id}/result`, 'bob', { claimId, ok: 'yes' })).status).toBe(400);
    expect((await post(`turns/${id}/result`, 'bob', { claimId, ok: true, output: { blob: 'x'.repeat(17 * 1024) } })).status).toBe(413);
    const done = await post(`turns/${id}/result`, 'bob', { claimId, ok: true, output: { rows: [{ title: 'RAW-DATA-ROW' }] } });
    expect(done.status).toBe(200); expect(done.body).toEqual({ turnId: id, status: 'done' });
    await flush();
    expect((await post(`turns/${id}/result`, 'bob', { claimId, ok: true, output: {} })).status).toBe(409);
    expect((await chat()).map((m) => m.message).join('\n')).not.toContain('RAW-DATA-ROW');
    expect((await novaMessages('assistant-reply')).map((m) => m.message)).toEqual(['Here is the result.']);
  });

  it('a private tool is answered to the asker alone: only the fixed line in the chat, one private notification', async () => {
    await post('invite');
    await ask('alice', 'Nova, how much budget do I have');
    const [turn] = (await get('turns?mine=1', 'alice')).body.turns;
    expect(turn.kind).toBe('private-read');
    const { claimId } = (await post(`turns/${turn.turnId}/claim`, 'alice')).body;
    await post(`turns/${turn.turnId}/result`, 'alice', { claimId, ok: true, output: { spent: 3 } });
    await flush();
    // Audit B2: the call chat gets one fixed line and none of the answer.
    expect((await novaMessages('assistant-reply')).map((m) => m.message)).toEqual(['Answered privately for Alice Ames.']);
    expect(notified.filter((n) => n.input.type === 'assistant-private-reply').map((n) => n.userId)).toEqual(['alice']);
  });
});

describe('a write in the call chat', () => {
  it('shows a card for the asker; nothing reaches the browser until the asker confirms; another person cannot confirm', async () => {
    await post('invite');
    await ask('alice', 'Nova, create a work item for the login cookie bug');
    const cards = await novaMessages('assistant-action');
    expect(cards).toHaveLength(1);
    const meta = cards[0]!.metadata as { actionId: string; askedBy: string; status: string; summary: string };
    expect(meta).toMatchObject({ askedBy: 'alice', status: 'waiting', summary: 'Create a work item titled "the login cookie bug"' });
    expect((await get('turns?mine=1', 'alice')).body.turns).toEqual([]);
    expect((await post(`actions/${meta.actionId}/decision`, 'bob', { decision: 'confirm' })).status).toBe(403);
    expect((await get('turns?mine=1', 'alice')).body.turns).toEqual([]);
    const pendingWrite = (await assistantStore().listTurns(CALL))[0]!;
    expect((await post(`turns/${pendingWrite.turnId}/claim`, 'alice')).status).toBe(409);  // not confirmed yet: nothing to run
    expect((await post(`actions/${meta.actionId}/decision`, 'alice', { decision: 'confirm' })).status).toBe(200);
    const turns = (await get('turns?mine=1', 'alice')).body.turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ kind: 'write', status: 'running', actionId: meta.actionId, tool: { name: 'create' } });
    expect((await get('turns?mine=1', 'bob')).body.turns).toEqual([]);
    expect((await post(`turns/${turns[0].turnId}/claim`, 'bob')).status).toBe(404);
    expect((await post(`turns/${turns[0].turnId}/result`, 'bob', { claimId: 'aaaaaaaaaaaaaaaa', ok: true })).status).toBe(404);
    const writeClaim = (await post(`turns/${turns[0].turnId}/claim`, 'alice')).body;
    expect(writeClaim).toMatchObject({ kind: 'write', tool: { name: 'create' } });
    expect((await post(`turns/${turns[0].turnId}/result`, 'alice', { claimId: writeClaim.claimId, ok: true, output: { say: 'Created.' } })).status).toBe(200);
    expect((await assistantStore().getAction(CALL, meta.actionId))).toMatchObject({ status: 'done', resultText: 'Created.' });
    const card = (await chat()).find((m) => m.id === cards[0]!.id)!;
    expect((card.metadata as { status: string }).status).toBe('done');
  });

  it('a declined card leaves no turn for the browser', async () => {
    await post('invite');
    await ask('alice', 'Nova, create a work item for the login cookie bug');
    const meta = (await novaMessages('assistant-action'))[0]!.metadata as { actionId: string };
    expect((await post(`actions/${meta.actionId}/decision`, 'alice', { decision: 'decline' })).status).toBe(200);
    expect((await get('turns?mine=1', 'alice')).body.turns).toEqual([]);
  });
});

describe('the name lock through the dev call', () => {
  it('a tool call attributed to someone who never said the name is refused, counted on the state, and posts nothing', async () => {
    await post('invite');
    expect((await get('state')).body.refusedCalls).toBe(0);
    const before = (await chat()).length;
    expect((await devCall({ askedBy: 'bob', name: 'search', args: { query: 'x' } })).status).toBe(202);
    await flush();
    expect((await get('state')).body.refusedCalls).toBe(1);
    expect((await chat()).length).toBe(before);
    expect((await get('turns', 'bob')).body.turns).toEqual([]);
  });

  it('the dev call answers 404 with the flag off and 409 with no assistant', async () => {
    expect((await devCall({ askedBy: 'bob', name: 'search', args: {} })).status).toBe(409);
    mockConfig.meetingAssistant.enabled = false;
    expect((await devCall({ askedBy: 'bob', name: 'search', args: {} })).status).toBe(404);
    expect((await get('turns', 'bob')).status).toBe(404);
  });
});

describe('turn routes: who may call them', () => {
  it('need the flag and a seat; a person without a seat is refused', async () => {
    await post('invite');
    sessions.set('dave', mk('dave'));
    expect((await get('turns', 'dave')).status).toBe(403);
    expect((await post('turns/t-1/result', 'dave', { claimId: 'aaaaaaaaaaaaaaaa', ok: true })).status).toBe(403);
    expect((await post('turns/t-1/claim', 'dave')).status).toBe(403);
    expect((await post('turns/t-nope/claim', 'alice')).status).toBe(404);
    expect((await post('turns/t-nope/result', 'alice', { claimId: 'aaaaaaaaaaaaaaaa', ok: true })).status).toBe(404);
  });
});

describe('pause and dismiss reach the session', () => {
  it('while paused a request is not heard, and a dismissed assistant answers nothing more', async () => {
    await post('invite');
    await post('pause', 'bob');
    await ask('alice', 'Nova, what is two plus two?');
    expect(await novaMessages('assistant-reply')).toEqual([]);
    await post('resume', 'bob');
    await ask('alice', 'Nova, what is two plus two?');
    expect((await novaMessages('assistant-reply')).map((m) => m.message)).toEqual(['Four.']);
    await post('dismiss', 'alice');
    await ask('alice', 'Nova, what is two plus two?');
    expect((await novaMessages('assistant-reply')).length).toBe(1);
  });

  it('an invite with no session available answers 503 and creates no record', async () => {
    setSessionFactory(() => null);
    const res = await post('invite');
    expect(res.status).toBe(503);
    expect((await get('state')).body.state).toBe('none');
  });
});
