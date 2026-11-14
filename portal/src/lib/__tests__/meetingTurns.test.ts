// The call assistant's turns in the asker's browser: what runs, what never runs, and that nothing runs twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingResults, SeenTurns, flushResults, parseClaim, parseTurns, privateSay, processTurns, resultBody, runnable, turnPollBaseMs, TURN_POLL_MS, TURN_POLL_HIDDEN_MS, type AssistantTurn, type ClaimResult } from '../meetingTurns.ts';
import { runCallTool } from '../voice/runCore.ts';
import { fakeFetch, route, toolContext } from '../voice/__tests__/voiceHarness.ts';

const NOW = 1_000_000;
const turn = (over: Partial<AssistantTurn> & { turnId: string }): AssistantTurn =>
  ({ kind: 'read', status: 'pending', tool: { name: 'search', args: { query: 'login' } }, expiresAt: NOW + 60_000, ...over });

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: () => null, get length() { return m.size; } };
}

function harness(storage: Storage | null = memoryStorage()) {
  const ran: Array<{ name: string; write: boolean }> = [];
  const posted: Array<{ turnId: string; body: { claimId: string; ok: boolean; output?: unknown; error?: string } }> = [];
  const seen = new SeenTurns('k', () => storage);
  const pending = new PendingResults('p', () => storage);
  const claimed: string[] = [];
  return {
    ran, posted, seen, pending, storage, claimed,
    deps: {
      seen, pending, now: () => NOW, wall: () => NOW,
      claim: async (turnId: string): Promise<ClaimResult> => { claimed.push(turnId); return { status: 'claimed', claimId: `c-${turnId}`, kind: 'read', tool: { name: 'search', args: { query: 'login' } } }; },
      run: async (name: string, _args: unknown, write: boolean) => { ran.push({ name, write }); return { ok: true, output: { say: 'ok' } }; },
      post: async (turnId: string, body: { claimId: string; ok: boolean; output?: unknown; error?: string }) => { posted.push({ turnId, body }); return 200; },
    },
  };
}

test('a pending read runs once and its result is posted; the same turn listed again does not run', async () => {
  const h = harness();
  const list = [turn({ turnId: 't-1' })];
  assert.equal(await processTurns(list, h.deps), 1);
  assert.equal(await processTurns(list, h.deps), 0);
  assert.deepEqual(h.ran, [{ name: 'search', write: false }]);
  assert.deepEqual(h.posted, [{ turnId: 't-1', body: { claimId: 'c-t-1', ok: true, output: { say: 'ok' } } }]);
});

test('a write that is still pending (its card not confirmed) never runs, and runs once it is running', async () => {
  const h = harness();
  const pending = turn({ turnId: 't-w', kind: 'write', status: 'pending', tool: { name: 'create', args: {} } });
  assert.equal(await processTurns([pending], h.deps), 0);
  assert.equal(h.ran.length, 0);
  h.deps.claim = async () => ({ status: 'claimed', claimId: 'c-w', kind: 'write', tool: { name: 'create', args: {} } });
  assert.equal(await processTurns([{ ...pending, status: 'running' }], h.deps), 1);
  assert.deepEqual(h.ran, [{ name: 'create', write: true }]);
  assert.equal(await processTurns([{ ...pending, status: 'running' }], h.deps), 0);
});

test('a turn past its expiry is skipped, and so is anything neither pending nor running', async () => {
  const h = harness();
  assert.equal(await processTurns([turn({ turnId: 'a', expiresAt: NOW }), turn({ turnId: 'b', status: 'done' }), turn({ turnId: 'c', kind: 'write', status: 'declined' })], h.deps), 0);
  assert.equal(runnable(turn({ turnId: 'd', kind: 'private-read' }), NOW), true);
});

test('a reload (a new ledger on the same storage) does not run a taken turn again', async () => {
  const storage = memoryStorage();
  const first = harness(storage);
  await processTurns([turn({ turnId: 't-1' })], first.deps);
  const second = harness(storage);
  assert.equal(await processTurns([turn({ turnId: 't-1' })], second.deps), 0);
  assert.equal(second.ran.length, 0);
});

test('with storage blocked the in-memory ledger still holds', async () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } as unknown as Storage;
  const h = harness(blocked);
  await processTurns([turn({ turnId: 't-1' })], h.deps);
  assert.equal(await processTurns([turn({ turnId: 't-1' })], h.deps), 0);
});

test('a runner that throws still answers the turn, with a plain sentence', async () => {
  const h = harness();
  h.deps.run = async () => { throw new Error('boom'); };
  await processTurns([turn({ turnId: 't-1' })], h.deps);
  assert.equal(h.posted[0]!.body.ok, false);
  assert.match(h.posted[0]!.body.error!, /boom/);
});

test('parseTurns drops rows that are not turns', () => {
  const rows = parseTurns({ turns: [{ turnId: 'a', kind: 'read', status: 'pending', tool: { name: 'search', args: {} }, expiresAt: 5 }, { turnId: 'b' }, 'x', { turnId: 'c', kind: 'odd', tool: { name: 's' }, expiresAt: 1 }] });
  assert.deepEqual(rows.map((r) => r.turnId), ['a']);
  assert.deepEqual(parseTurns(null), []);
});

test('runCallTool runs a read through the executor with the person\'s own can(), and refuses what the executor refuses', async () => {
  const { fetch } = fakeFetch([route('GET', '/api/search', 200, { results: [{ id: 'w-1', title: 'Login cookie bug', type: 'work-item' }], total: 1 })]);
  const ctx = toolContext({ fetch });
  const ok = await runCallTool('search', { query: 'login' }, ctx, { write: false });
  assert.equal(ok.ok, true);
  assert.ok(JSON.stringify(ok.output).length < 14_000);
  const dctx = toolContext({ deny: ['DispatchAgentRun'] });
  const denied = await runCallTool('create', { kind: 'work-item', fields: { title: 'x' } }, dctx, { write: true });
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? '', /.+/);
});

test('runCallTool refuses navigation, malformed arguments, and a write tool offered as a read', async () => {
  const ctx = toolContext();
  assert.equal((await runCallTool('open', { page: 'budgets' }, ctx, { write: false })).ok, false);
  assert.equal((await runCallTool('computer', {}, ctx, { write: true })).ok, false);
  const bad = await runCallTool('create', { kind: 'work-item', fields: { title: 'x', assignee: 'Priya' } }, ctx, { write: true });
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /.+/);
  const asRead = await runCallTool('create', { kind: 'work-item', fields: { title: 'x' } }, ctx, { write: false });
  assert.equal(asRead.ok, false);
  assert.equal(ctx.navigations.length, 0);
});

test('a confirmed write runs through the voice planner and runner, and the result carries the line the card shows', async () => {
  const { fetch, log } = fakeFetch([
    route('GET', '/api/graph/projects', 200, [{ id: 'p-auth', name: 'Auth Migration' }]),
    route('POST', '/api/graph/work-items', 200, { id: 'w-9', title: 'Login cookie bug' }),
  ]);
  const ctx = toolContext({ fetch, results: undefined });
  const out = await runCallTool('create', { kind: 'work-item', fields: { title: 'Login cookie bug', initiative: 'Auth Migration' } }, ctx, { write: true });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(typeof out.output!['say'], 'string');
  assert.equal(log.filter((r) => r.method === 'POST' && r.url.includes('/api/graph/work-items')).length, 1);
  // The same call again on the same ledger is not sent twice.
  await runCallTool('create', { kind: 'work-item', fields: { title: 'Login cookie bug', initiative: 'Auth Migration' } }, ctx, { write: true });
  assert.equal(log.filter((r) => r.method === 'POST' && r.url.includes('/api/graph/work-items')).length, 1);
});

test('a turn is claimed first and runs the tool and kind the claim answered, not the list\'s', async () => {
  const h = harness();
  h.deps.claim = async () => ({ status: 'claimed', claimId: 'c-1', kind: 'write', tool: { name: 'create', args: { kind: 'work-item' } } });
  await processTurns([turn({ turnId: 't-1', kind: 'write', status: 'running', tool: { name: 'search', args: {} } })], h.deps);
  assert.deepEqual(h.ran, [{ name: 'create', write: true }]);
  assert.equal(h.posted[0]!.body.claimId, 'c-1');
});

test('a refused claim (another tab won, or it is not this person\'s) runs nothing and is not asked again; an errored claim is asked again', async () => {
  const h = harness();
  let answer: ClaimResult = { status: 'refused' };
  h.deps.claim = async (id: string) => { h.claimed.push(id); return answer; };
  assert.equal(await processTurns([turn({ turnId: 't-1' })], h.deps), 0);
  assert.equal(await processTurns([turn({ turnId: 't-1' })], h.deps), 0);
  assert.deepEqual(h.claimed, ['t-1']);
  answer = { status: 'error' };
  await processTurns([turn({ turnId: 't-2' })], h.deps);
  await processTurns([turn({ turnId: 't-2' })], h.deps);
  assert.deepEqual(h.claimed, ['t-1', 't-2', 't-2']);
  assert.equal(h.ran.length, 0);
});

test('two tabs of one person, one server: exactly one run', async () => {
  let taken = false;
  const claim = async (): Promise<ClaimResult> => {
    if (taken) return { status: 'refused' };
    taken = true; return { status: 'claimed', claimId: 'c', kind: 'write', tool: { name: 'create', args: {} } };
  };
  const a = harness(memoryStorage()); const b = harness(memoryStorage());
  a.deps.claim = claim; b.deps.claim = claim;
  const list = [turn({ turnId: 't-w', kind: 'write', status: 'running' })];
  await Promise.all([processTurns(list, a.deps), processTurns(list, b.deps)]);
  assert.equal(a.ran.length + b.ran.length, 1);
});

test('a private read posts only { say }, at most 600 characters', async () => {
  assert.deepEqual(resultBody('private-read', { ok: true, output: { say: 'You have 12 dollars left.', rows: [1, 2, 3], secret: 'x' } }), { ok: true, output: { say: 'You have 12 dollars left.' } });
  assert.ok(privateSay({ say: 'a'.repeat(900) }).length <= 600);
  assert.match(privateSay({}), /.+/);
  assert.deepEqual(resultBody('read', { ok: true, output: { say: 'a', n: 1 } }), { ok: true, output: { say: 'a', n: 1 } });
  assert.deepEqual(resultBody('write', { ok: false, error: 'No.' }), { ok: false, error: 'No.' });
});

test('a result that fails to post is kept and retried with backoff until accepted; a final answer drops it', async () => {
  const storage = memoryStorage();
  const h = harness(storage);
  let wall = NOW; let status = 0;
  const deps = { ...h.deps, wall: () => wall, post: async (turnId: string, body: { claimId: string; ok: boolean }) => { h.posted.push({ turnId, body }); return status; } };
  await processTurns([turn({ turnId: 't-1' })], deps);
  assert.equal(h.posted.length, 1);
  assert.equal(h.pending.size, 1);
  assert.equal(await flushResults(deps), NOW + 1000); // not due yet: no post
  assert.equal(h.posted.length, 1);
  wall = NOW + 1000; status = 500;
  assert.equal(await flushResults(deps), NOW + 1000 + 2000);
  wall = NOW + 3000; status = 0;
  assert.equal(await flushResults(deps), NOW + 3000 + 4000);
  // a reload: a new PendingResults on the same storage still holds it, and it posts instead of running
  const again = harness(storage);
  assert.equal(again.pending.size, 1);
  status = 200;
  await flushResults({ ...again.deps, post: async (turnId, body) => { again.posted.push({ turnId, body }); return 200; } });
  assert.equal(again.pending.size, 0);
  assert.equal(again.ran.length, 0);
  assert.equal(again.posted[0]!.body.claimId, 'c-t-1');
});

test('409, 404 and 413 are final; an expired turn (by the server clock) is dropped without posting', async () => {
  for (const code of [409, 404, 413]) {
    const h = harness();
    h.pending.add({ turnId: 'x', claimId: 'c', expiresAt: NOW + 5000, body: { ok: true } });
    assert.equal(await flushResults({ ...h.deps, post: async () => code }), null);
    assert.equal(h.pending.size, 0);
  }
  const h = harness();
  h.pending.add({ turnId: 'x', claimId: 'c', expiresAt: NOW - 1, body: { ok: true } });
  await flushResults(h.deps);
  assert.equal(h.posted.length, 0);
  assert.equal(h.pending.size, 0);
});

test('backoff is capped at 15 seconds', () => {
  const p = new PendingResults('q', () => null);
  let at = 0;
  for (let i = 0; i < 8; i += 1) at = p.failed('x', 0);
  assert.equal(at, 15_000);
});

test('parseClaim reads a claim and refuses a body that is not one', () => {
  assert.deepEqual(parseClaim({ turnId: 't', claimId: 'c', kind: 'read', tool: { name: 'search', args: { q: 1 } } }), { status: 'claimed', claimId: 'c', kind: 'read', tool: { name: 'search', args: { q: 1 } } });
  assert.equal(parseClaim({ claimId: '', kind: 'read', tool: { name: 's' } }).status, 'error');
  assert.equal(parseClaim(null).status, 'error');
});

test('a seated person keeps polling when the tab is hidden, slower; a person not seated has no timer', () => {
  assert.equal(turnPollBaseMs('active', false), TURN_POLL_MS);
  assert.equal(turnPollBaseMs('active', true), TURN_POLL_HIDDEN_MS);
  assert.equal(TURN_POLL_MS, 2000);
  assert.equal(TURN_POLL_HIDDEN_MS, 5000);
  assert.equal(turnPollBaseMs('poke', true), null);
  assert.equal(turnPollBaseMs('off', false), null);
});

test('a write claimed late keeps its result: the claim answers the new expiry and the kept result uses it', async () => {
  const { parseClaim } = await import('../meetingTurns.ts');
  assert.equal((parseClaim({ claimId: 'c', kind: 'write', tool: { name: 'create' }, expiresAt: NOW + 90_000 }) as { expiresAt?: number }).expiresAt, NOW + 90_000);
  assert.equal((parseClaim({ claimId: 'c', kind: 'write', tool: { name: 'create' }, expiresAt: 'soon' }) as { expiresAt?: number }).expiresAt, undefined);
  const h = harness();
  let wall = NOW;
  h.deps.claim = async () => ({ status: 'claimed', claimId: 'c-w', kind: 'write', tool: { name: 'create', args: {} }, expiresAt: NOW + 90_000 });
  const deps = { ...h.deps, wall: () => wall, now: () => wall, post: async () => 500 };
  await processTurns([turn({ turnId: 't-w', kind: 'write', status: 'running', expiresAt: NOW + 1000 })], deps);
  assert.equal(h.pending.list()[0]!.expiresAt, NOW + 90_000);
  wall = NOW + 30_000; // past the listed expiry, inside the claim's: the result is still posted, not dropped
  await flushResults({ ...deps, post: async (turnId, body) => { h.posted.push({ turnId, body }); return 200; } });
  assert.equal(h.posted.length, 1);
  assert.equal(h.pending.size, 0);
});

test('a poll chain keeps one timer, whatever nudges arrive during a poll', async () => {
  const { pollChain } = await import('../meetingTurns.ts');
  const timers = new Map<number, () => void>();
  let id = 0; let polls = 0; let release: (() => void) | null = null;
  const chain = pollChain<number>({
    poll: () => { polls += 1; return new Promise<boolean>((resolve) => { release = () => resolve(true); }); },
    nextMs: () => 2000,
    schedule: (fn) => { id += 1; timers.set(id, fn); return id; },
    cancel: (h) => { timers.delete(h); },
  });
  chain.start();
  chain.nudge(); chain.nudge(); // visibility changes during the poll
  assert.equal(polls, 1);
  release!(); await new Promise((r) => setImmediate(r));
  assert.equal(timers.size, 1, 'exactly one timer waits');
  chain.nudge(); // between polls: the waiting timer is replaced by an immediate poll
  assert.equal(timers.size, 0);
  assert.equal(polls, 2);
  release!(); await new Promise((r) => setImmediate(r));
  assert.equal(timers.size, 1);
  chain.stop();
  assert.equal(timers.size, 0);
});
