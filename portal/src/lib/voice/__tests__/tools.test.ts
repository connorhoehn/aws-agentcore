import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FIELD_CHARS, MAX_ROWS, DATA_NOTE, ResultMemory, localHref, parseSince, parseToolArgs, runVoiceTool, shapeOutput, spokenOrdinal, voicePage } from '../tools.ts';
import { VOICE_TENANTS, VOICE_TOOLS, navigatePageIds, voiceToolSpec } from '../catalogue.ts';
import { PALETTE, fakeFetch, route, toolContext } from './voiceHarness.ts';

/** A valid call per P3 tool, and the context that refuses it. */
const P3_REFUSALS: Array<{ tool: string; args: Record<string, unknown>; ctx: Parameters<typeof toolContext>[0] }> = [
  { tool: 'search', args: { query: 'kubernetes', type: 'person' }, ctx: { deny: ['Search'] } },
  { tool: 'search', args: { query: 'auth migration', type: 'decision', answer: true }, ctx: { deny: ['Search'] } },
  { tool: 'search', args: { query: 'who approved it', answer: true }, ctx: { tenant: 'access', deny: ['ViewAccess'] } },
  { tool: 'open', args: { page: 'bots' }, ctx: { role: 'member' } },
  { tool: 'open', args: { page: 'computers' }, ctx: { tenant: 'social' } },
  { tool: 'open', args: { ref: 'bot:b1' }, ctx: { role: 'member', deny: ['ManageBots'] } },
  { tool: 'open', args: { kind: 'initiative' }, ctx: {} },
  { tool: 'open', args: { page: 'search', ref: '1' }, ctx: {} },
  { tool: 'open', args: { kind: 'request', name: 'SME' }, ctx: { tenant: 'orgiq' } },
  { tool: 'open', args: { ref: 'work-item:w1' }, ctx: {} },
  { tool: 'list', args: { kind: 'initiative' }, ctx: { tenant: 'social' } },
  { tool: 'list', args: { kind: 'bot' }, ctx: { role: 'member', deny: ['ManageBots'] } },
  { tool: 'list', args: { kind: 'channel' }, ctx: { tenant: 'orgiq', social: null } },
  { tool: 'list', args: { kind: 'request', filter: { scope: 'all' } }, ctx: { tenant: 'access' } },
  { tool: 'list', args: { kind: 'finding', filter: { since: 'next week' } }, ctx: {} },
  { tool: 'get', args: { ref: 'bot:b1' }, ctx: { role: 'member', deny: ['ManageBots'] } },
  { tool: 'get', args: { ref: '1' }, ctx: {} },
  { tool: 'get', args: { ref: 'Alpha' }, ctx: {} },
  { tool: 'get', args: { ref: 'initiative:p1', part: 'steps' }, ctx: {} },
  { tool: 'get', args: { ref: 'person:p-9' }, ctx: { deny: ['ViewOrgChart'] } },
  { tool: 'summary', args: { kind: 'sweeps', since: 'yesterday' }, ctx: { tenant: 'social' } },
  { tool: 'summary', args: { kind: 'sweeps', since: 'next tuesday' }, ctx: {} },
  { tool: 'summary', args: { kind: 'fleet' }, ctx: { role: 'member', deny: ['ManageDevbox'] } },
  { tool: 'summary', args: { kind: 'health' }, ctx: { deny: ['ViewObservability'] } },
  { tool: 'summary', args: { kind: 'ingest' }, ctx: { role: 'sme', deny: ['ManageIngest'] } },
  { tool: 'summary', args: { kind: 'live' }, ctx: { tenant: 'pipelines', social: null } },
  { tool: 'summary', args: { kind: 'pipelines' }, ctx: { tenant: 'pipelines', deny: ['ViewPipelines'] } },
  { tool: 'summary', args: { kind: 'rollup' }, ctx: { tenant: 'access' } },
  { tool: 'access_request_status', args: { query: 'budgets' }, ctx: { tenant: 'access', deny: ['ViewAccess'] } },
  { tool: 'access_request_status', args: { scope: 'approvals' }, ctx: { tenant: 'access', role: 'requester', allow: ['ViewAccess', 'RequestAccess'] } },
  { tool: 'access_request_status', args: { scope: 'approvals' }, ctx: { tenant: 'orgiq' } },
  { tool: 'access_request_status', args: { scope: 'reports', query: 'sme' }, ctx: { tenant: 'social' } },
];

test('every P3 tool refuses on its gate without a network call', async () => {
  for (const { tool, args, ctx } of P3_REFUSALS) {
    let calls = 0;
    const c = toolContext({ ...ctx, fetch: async () => { calls++; throw new Error('network'); } });
    const r = await runVoiceTool(tool, JSON.stringify(args), c);
    assert.equal(r.outcome, 'refused', tool);
    assert.equal(r.output['kind'], 'refused', tool);
    assert.equal(typeof r.output['reason'], 'string');
    assert.equal(calls, 0, `${tool} made no request`);
    assert.deepEqual(c.navigations, [], `${tool} opened nothing`);
  }
});

test('arguments: strict nulls are dropped, then lengths, ranges, enums and unknown keys are enforced', () => {
  const people = voiceToolSpec('search')!;
  assert.deepEqual(parseToolArgs(people, '{"query":"Kubernetes experts","type":"person","scope":null,"sort":"recent","limit":null,"answer":null}'),
    { ok: true, args: { query: 'Kubernetes experts', type: 'person', sort: 'recent' }, ignored: [] });
  assert.deepEqual(parseToolArgs(people, '{"query":"who decided it","answer":true}'), { ok: true, args: { query: 'who decided it', answer: true }, ignored: [] });
  // Strict mode sends every property: a boolean false is an answer, never "a whole number" (review finding).
  assert.deepEqual(parseToolArgs(people, '{"query":"kubernetes","type":null,"scope":null,"sort":null,"limit":null,"answer":false}'), { ok: true, args: { query: 'kubernetes', answer: false }, ignored: [] });
  for (const bad of ['{"query":""}', '{"query":"x","limit":11}', '{"query":"x","limit":2.5}', '{"query":"x","sort":"newest"}', '{"query":"x","answer":"yes"}',
    '{"query":"x","tenant":"access"}', '{}', 'not json', JSON.stringify({ query: 'x'.repeat(201) })]) {
    assert.equal(parseToolArgs(people, bad).ok, false, bad);
  }
  const nav = voiceToolSpec('open')!;
  assert.equal(parseToolArgs(nav, '{"page":"search","params":{"q":"k8s","type":null,"id":null}}').ok, true);
  assert.equal(parseToolArgs(nav, '{"route":"/iq/local-compute"}').ok, false, 'the V1 probe\'s own shape is not the catalogue\'s');
});

test('open { page } refuses an unknown page id and a page outside the tenant or the role, table-driven over PAGES', async () => {
  const unknown = await runVoiceTool('open', { page: 'admin-identity' }, toolContext());
  assert.equal(unknown.outcome, 'refused', 'not in the enum');
  const crossTenant = await runVoiceTool('open', { page: 'teams' }, toolContext({ tenant: 'orgiq' }));
  assert.equal(crossTenant.outcome, 'refused', 'a social page from orgiq');

  // Every role of every tenant, over every page id: the id resolves to its own tenant's palette row, gated by isPageVisible.
  const roles = ['member', 'sme', 'program-owner', 'org-leader', 'hr-admin', 'admin', 'participant', 'moderator',
    'assessor', 'program-lead', 'author', 'operator', 'requester', 'approver', 'access-admin'];
  assert.equal(PALETTE.pages.filter((p) => p.pageId).length, PALETTE.pages.length, 'the real palette table: every page has an id (V2-2)');
  const inTenant = (p: { tenant: string }, t: string) => p.tenant === t || p.tenant === 'universal' || (p.tenant === 'admin' && t === 'orgiq');
  const ids = [...new Set(PALETTE.pages.filter((p) => p.pageId).map((p) => p.pageId!))];
  for (const id of ids) {
    for (const tenant of VOICE_TENANTS) {
      for (const role of roles) {
        const c = toolContext({ tenant, role });
        const r = await runVoiceTool('open', { page: id }, c);
        const target = PALETTE.pages.find((p) => p.pageId === id && inTenant(p, tenant));
        const expected = navigatePageIds(tenant).includes(id) && !!target && PALETTE.visible(target, tenant, role);
        assert.equal(r.outcome === 'done', expected, `${id} as ${role} in ${tenant}`);
        assert.deepEqual(c.navigations, expected ? [target!.path] : [], `${id} as ${role} in ${tenant}`);
      }
    }
  }
  // A repeated id opens the session's own tenant's page, with a record id where the route takes one.
  const runs = toolContext({ tenant: 'pipelines', role: 'author' });
  await runVoiceTool('open', { page: 'runs', params: { id: 'run-7' } }, runs);
  assert.deepEqual(runs.navigations, ['/pipelines/runs/run-7']);
  const teams = toolContext({ tenant: 'assessment', role: 'assessor' });
  await runVoiceTool('open', { page: 'teams' }, teams);
  assert.deepEqual(teams.navigations, ['/assessment/teams']);
  const ws = toolContext({ tenant: 'social', role: 'social-member' });
  const out = await runVoiceTool('open', { page: 'workspaces' }, ws);
  assert.equal(out.outcome, 'done');
  assert.match(String(out.output['warning']), /ends this voice session/);
  assert.equal(voicePage(PALETTE, 'workspaces')!.path, '/workspaces');
});

test('search for people navigates the page and reads the same search, shaping rows as data', async () => {
  const long = 'k'.repeat(400);
  const results = Array.from({ length: 14 }, (_, i) => ({
    type: 'person', id: `p${i}`, title: `Person ${i}`, subtitle: 'Platform', description: long, href: `/iq/people/p${i}`,
    matchReason: 'Skill match', updatedAt: '2026-11-07T00:00:00Z', avatarUrl: 'https://x/y.png', sourceRefs: [{ type: 'team', id: 't' }],
  }));
  const { fetch, log } = fakeFetch([route('GET', '/api/search?', 200, { query: 'kubernetes', results, total: 14, counts: {} })]);
  const c = toolContext({ fetch });
  const r = await runVoiceTool('search', '{"query":"Kubernetes experts","type":"person","scope":null,"limit":null,"sort":"recent","answer":null}', c);
  assert.equal(r.outcome, 'done');
  assert.deepEqual(c.navigations, ['/iq/search?q=Kubernetes+experts&type=person&tab=results&sort=recent']);
  assert.equal(log[0]!.url, '/api/search?q=Kubernetes+experts&type=person&limit=5&sort=recent');
  assert.equal(r.output['note'], DATA_NOTE);
  assert.equal(r.output['kind'], 'search_results');
  const rows = r.output['rows'] as Array<Record<string, unknown>>;
  assert.equal(rows.length, 5);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['detail', 'href', 'matched', 'ref', 'subtitle', 'title', 'type', 'updatedAt']);
  assert.equal(rows[0]!['ref'], 'person:p0', 'the row\'s own id, for open_result');
  assert.equal((rows[0]!['detail'] as string).length, MAX_FIELD_CHARS);
});

test('a search the server refuses is a refusal, an outage a failure', async () => {
  const forbidden = fakeFetch([route('GET', '/api/search', 403, { error: 'Forbidden' })]);
  assert.equal((await runVoiceTool('search', { query: 'x' }, toolContext({ fetch: forbidden.fetch }))).outcome, 'refused');
  const down = fakeFetch([route('GET', '/api/search', 502, {})]);
  assert.equal((await runVoiceTool('search', { query: 'x' }, toolContext({ fetch: down.fetch }))).outcome, 'failed');
});

test('search answer: a tenant\'s /answer fact with the records it read; no fact falls back to the matching records', async () => {
  const answer = { intent: 'assessment:below-target', text: '2 teams are below the target level: Atlas and Borealis.', records: [
    { type: 'team', id: 't-atlas', title: 'Atlas', href: '/assessment/teams/t-atlas', n: 1, status: 'in_progress' },
    { type: 'team', id: 't-bor', title: 'Borealis', href: '/assessment/teams/t-bor', n: 2 },
  ], rows: [{ secret: 'never sent' }], sources: ['the scorecards'] };
  const { fetch, log } = fakeFetch([route('GET', '/api/assessment/search/answer?', 200, { query: 'q', answer })]);
  const results = new ResultMemory();
  const c = toolContext({ fetch, tenant: 'assessment', role: 'assessor', allow: ['ViewAssessment'], results });
  const r = await runVoiceTool('search', { query: 'Which teams are below target?', answer: true }, c);
  assert.equal(r.outcome, 'done');
  assert.equal(r.output['kind'], 'search_answer');
  assert.equal(r.output['answer'], answer.text);
  assert.equal(r.summary, answer.text);
  assert.deepEqual(log.map((l) => l.url), ['/api/assessment/search/answer?q=Which+teams+are+below+target%3F']);
  assert.deepEqual((r.output['rows'] as Array<{ ref: string }>).map((x) => x.ref), ['team:t-atlas', 'team:t-bor']);
  assert.doesNotMatch(JSON.stringify(r.output), /never sent|scorecards/, 'only the fact and the records, never the structured rows');
  assert.equal(results.find('2')!.href, '/assessment/teams/t-bor', 'the records are kept for "the second one"');

  // No intent recognised: the plain search answers, and says no fact was found.
  const none = fakeFetch([route('GET', '/api/pipelines/search/answer?', 200, { query: 'q', answer: null }),
    route('GET', '/api/pipelines/search?', 200, { results: [{ type: 'run', id: 'run-9', title: 'Nightly ingest', status: 'failed', href: '/pipelines/runs/run-9' }], total: 1 })]);
  const p = await runVoiceTool('search', { query: 'what failed', answer: true }, toolContext({ fetch: none.fetch, tenant: 'pipelines', allow: ['ViewPipelines'] }));
  assert.equal(p.output['kind'], 'search_results');
  assert.match(String(p.output['noAnswer']), /No question the index answers/);
  assert.deepEqual(none.log.map((l) => l.url.split('?')[0]), ['/api/pipelines/search/answer', '/api/pipelines/search']);
  // A refused /answer is a refusal, with no second read.
  const denied = fakeFetch([route('GET', '/api/access/search/answer?', 403, {})]);
  assert.equal((await runVoiceTool('search', { query: 'x', answer: true }, toolContext({ fetch: denied.fetch, tenant: 'access', allow: ['ViewAccess'] }))).outcome, 'refused');
  assert.equal(denied.log.length, 1);
});

test('search answer in orgiq: the question intent\'s rows GET /api/search ranks first are the fact', async () => {
  const results = [
    { type: 'person', id: 'p-vera', title: 'Vera Green', matchReason: 'Decided it', href: '/iq/search?tab=connections&selection=person%3Ap-vera' },
    { type: 'decision', id: 'd-cut', title: 'Cutover order for legacy SSO tenants', matchReason: 'Decision the question names', href: '/iq/decisions/d-cut' },
    { type: 'work', id: 'w1', title: 'Cutover runbook', matchReason: 'Text match', href: '/iq/projects/p1' },
  ];
  const { fetch, log } = fakeFetch([route('GET', '/api/search?', 200, { results, total: 3 })]);
  const c = toolContext({ fetch, allow: ['Search'] });
  const r = await runVoiceTool('search', { query: 'who decided the cutover order', answer: true }, c);
  assert.equal(r.output['kind'], 'search_answer');
  assert.equal(r.output['answer'], 'Decided it: Vera Green');
  assert.equal(log[0]!.url, '/api/search?q=who+decided+the+cutover+order&type=all&limit=5');
  // A plain text match is not a fact.
  const plain = fakeFetch([route('GET', '/api/search?', 200, { results: [results[2]], total: 1 })]);
  const q = await runVoiceTool('search', { query: 'cutover runbook', answer: true }, toolContext({ fetch: plain.fetch, allow: ['Search'] }));
  assert.equal(q.output['kind'], 'search_results');
  assert.ok(q.output['noAnswer']);
});

test('search outside orgiq reads that tenant\'s own search, with its own types and gate, and opens no page', async () => {
  const huddle = { type: 'huddle', id: 'h1', title: 'Platform standup', kind: 'Huddle', subtitle: 'In the huddle now: Mira, Lena', status: 'live', href: '/social/calls', score: 3 };
  const { fetch, log } = fakeFetch([route('GET', '/api/social/search?', 200, { query: 'standup', results: [huddle], counts: { huddle: 1 }, total: 1 })]);
  const c = toolContext({ fetch, tenant: 'social', role: 'participant', allow: ['ViewSocial'] });
  const r = await runVoiceTool('search', '{"query":"standup","type":"huddle","scope":null,"limit":null}', c);
  assert.equal(r.outcome, 'done');
  assert.deepEqual(log.map((l) => l.url), ['/api/social/search?q=standup&type=huddle&limit=5']);
  assert.deepEqual(c.navigations, [], 'no search page outside orgiq');
  assert.deepEqual((r.output['rows'] as unknown[])[0], { ref: 'huddle:h1', title: 'Platform standup', type: 'huddle', subtitle: 'In the huddle now: Mira, Lena', status: 'live', href: '/social/calls' });

  // A type another tenant indexes is refused before the network; so is a role without the tenant search's own action.
  const foreign = await runVoiceTool('search', { query: 'x', type: 'initiative' }, toolContext({ fetch, tenant: 'social', allow: ['ViewSocial'] }));
  assert.equal(foreign.outcome, 'refused');
  const noView = await runVoiceTool('search', { query: 'x' }, toolContext({ fetch, tenant: 'social', allow: ['Search'] }));
  assert.equal(noView.outcome, 'refused');
  assert.equal(log.length, 1);
  // orgiq keeps GET /api/search, and `team` is a type there now.
  const org = fakeFetch([route('GET', '/api/search?', 200, { results: [{ type: 'team', id: 't1', title: 'Platform', href: '/iq/search?tab=connections' }], total: 1 })]);
  const t = await runVoiceTool('search', { query: 'platform', type: 'team' }, toolContext({ fetch: org.fetch, allow: ['Search'] }));
  assert.equal(t.outcome, 'done');
  assert.equal(org.log[0]!.url, '/api/search?q=platform&type=team&limit=5');
});

test('open { ref } opens a row the session\'s own search returned, by ref or position, and never a name, a path or another origin', async () => {
  const people = [
    { type: 'person', id: 'p-ada', title: 'Ada Okafor', subtitle: 'Platform', href: '/iq/search?tab=connections&selection=person%3Ap-ada' },
    { type: 'person', id: 'p-bo', title: 'Bo Lin', subtitle: 'SRE', href: '/iq/search?tab=connections&selection=person%3Ap-bo' },
  ];
  const { fetch, log } = fakeFetch([route('GET', '/api/search?', 200, { results: people, total: 2 })]);
  const results = new ResultMemory();
  const c = toolContext({ fetch, results });
  // Before any search there is nothing to open.
  assert.equal((await runVoiceTool('open', { ref: '1' }, c)).outcome, 'refused');
  const found = await runVoiceTool('search', { query: 'kubernetes', type: 'person' }, c);
  assert.deepEqual((found.output['rows'] as Array<{ ref: string }>).map((r) => r.ref), ['person:p-ada', 'person:p-bo']);
  c.navigations.length = 0;

  const first = await runVoiceTool('open', { ref: '1' }, c);
  assert.equal(first.outcome, 'done');
  assert.deepEqual(c.navigations, [people[0]!.href], 'the first row\'s own href: the person in the connections inspector');
  const byRef = await runVoiceTool('open', { ref: 'person:p-bo' }, c);
  assert.equal(byRef.summary, 'Opened Bo Lin');
  assert.deepEqual(c.navigations, [people[0]!.href, people[1]!.href]);

  // A name, a path, a position past the rows and another origin are all refused, and open nothing.
  for (const ref of ['Ada Okafor', '/admin/identity', '3', 'https://evil.example/x', '//evil.example/x', 'javascript:alert(1)']) {
    const r = await runVoiceTool('open', { ref }, c);
    assert.equal(r.outcome, 'refused', ref);
  }
  assert.equal(c.navigations.length, 2);
  // A typed ref no search returned opens through the kind's own href, built from the id (the page's route gates it).
  assert.equal((await runVoiceTool('open', { ref: 'person:p-zed' }, c)).outcome, 'done');
  assert.equal(c.navigations.at(-1), '/iq/search?tab=connections&selection=person%3Ap-zed');
  assert.equal(log.length, 1, 'open by ref never reads');
  // A context without the dock's memory (no session) cannot open anything.
  assert.equal((await runVoiceTool('open', { ref: '1' }, toolContext())).outcome, 'refused');
});

test('open refuses a kept row whose href leaves the portal; social profiles open on the contacts page', async () => {
  const results = new ResultMemory();
  results.keep([{ ref: 'contact:u-ada', title: 'Ada', href: '//evil.example/x' }]);
  const c = toolContext({ tenant: 'social', role: 'participant', results });
  assert.equal((await runVoiceTool('open', { ref: 'contact:u-ada' }, c)).outcome, 'refused');
  assert.deepEqual(c.navigations, []);
  for (const bad of ['//x', 'https://x', 'javascript:alert(1)', '\\x', 'x']) assert.equal(localHref(bad), false, bad);
  assert.equal(localHref('/social/contacts/u-ada'), true);

  const { fetch } = fakeFetch([route('GET', '/api/social/search?', 200, { results: [{ type: 'contact', id: 'u-ada', title: 'Ada Okafor', kind: 'Contact', href: '/social/contacts/u-ada', score: 2 }], total: 1 })]);
  const s = toolContext({ fetch, tenant: 'social', role: 'participant', allow: ['ViewSocial'], results: new ResultMemory() });
  await runVoiceTool('search', { query: 'ada', type: 'contact' }, s);
  assert.equal((await runVoiceTool('open', { ref: 'contact:u-ada' }, s)).outcome, 'done');
  assert.deepEqual(s.navigations, ['/social/contacts/u-ada']);
  // And navigate names the same profile by page id.
  const n = toolContext({ tenant: 'social', role: 'participant' });
  await runVoiceTool('open', { page: 'contacts', params: { id: 'u-ada' } }, n);
  assert.deepEqual(n.navigations, ['/social/contacts/u-ada']);
});

test('list reads a kind\'s own route with its server filters, filters the rest on the shaped rows, and keeps them for ordinals', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/graph/projects', 200, [
    { id: 'p1', name: 'Alpha migration', status: 'in_progress', ownerName: 'Ana', contributorCount: 4, lastActivityAt: '2026-11-08T09:00:00Z', description: 'secret body text', allocatedUsd: 75 },
    { id: 'p2', name: 'Beta', status: 'in_progress', ownerName: 'Bo', lastActivityAt: '2026-11-01T09:00:00Z' },
  ])]);
  const results = new ResultMemory();
  const c = toolContext({ fetch, results });
  const r = await runVoiceTool('list', '{"kind":"initiative","filter":null,"limit":null}', c);
  assert.equal(r.outcome, 'done');
  assert.equal(log[0]!.url, '/api/graph/projects?limit=50&scope=mine', 'scope mine by default, as the page');
  assert.deepEqual(r.output['rows'], [
    { ref: 'initiative:p1', title: 'Alpha migration', subtitle: 'Owner: Ana', status: 'in_progress', at: '2026-11-08T09:00:00Z', href: '/iq/projects/p1' },
    { ref: 'initiative:p2', title: 'Beta', subtitle: 'Owner: Bo', status: 'in_progress', at: '2026-11-01T09:00:00Z', href: '/iq/projects/p2' },
  ]);
  assert.doesNotMatch(JSON.stringify(r.output), /secret body|75/, 'no body, no money');
  assert.equal(r.summary, '2 initiatives; first: Alpha migration');
  assert.equal(results.find('2')!.href, '/iq/projects/p2', '"the second one"');
  // filter.q and filter.since apply to the shaped rows where the route takes neither; scope all goes to the route.
  const q = await runVoiceTool('list', { kind: 'initiative', filter: { q: 'alpha', scope: 'all', status: 'active', since: '2026-11-05' } }, c);
  assert.equal(log[1]!.url, '/api/graph/projects?limit=50&status=active&scope=all');
  assert.deepEqual((q.output['rows'] as Array<{ ref: string }>).map((x) => x.ref), ['initiative:p1']);
  assert.equal(q.output['count'], 1);
});

test('list in each tenant reads that tenant\'s route: access requests, pipeline runs, assessment teams, Social channels', async () => {
  const cases: Array<{ tenant: string; role: string; args: Record<string, unknown>; prefix: string; body: unknown; url: string; ref: string; href: string; ctx?: Parameters<typeof toolContext>[0] }> = [
    { tenant: 'access', role: 'requester', args: { kind: 'request', filter: { q: 'SME' } }, prefix: '/api/access/requests', url: '/api/access/requests?q=SME&scope=mine',
      body: { items: [{ id: 'r1', item: { title: 'SME in Work' }, requester: { displayName: 'Me' }, beneficiary: { displayName: 'Me' }, status: 'approved', justification: 'private reason' }] }, ref: 'request:r1', href: '/access/requests/r1' },
    { tenant: 'pipelines', role: 'operator', args: { kind: 'run', filter: { status: 'failed' } }, prefix: '/api/pipelines/runs', url: '/api/pipelines/runs?status=failed',
      body: { runs: [{ id: 'agent-run:9', definitionId: 'agent:nightly', status: 'failed', startedAt: '2026-11-08T02:00:00Z' }], total: 1 }, ref: 'run:agent-run:9', href: '/pipelines/runs/agent-run%3A9' },
    { tenant: 'assessment', role: 'assessor', args: { kind: 'team' }, prefix: '/api/assessment/teams', url: '/api/assessment/teams',
      body: [{ id: 'TEAM-001', name: 'Northstar', cohort_label: 'White Glove', status: 'IN_PROGRESS' }], ref: 'team:TEAM-001', href: '/assessment/teams/TEAM-001' },
    { tenant: 'social', role: 'participant', args: { kind: 'channel' }, prefix: '/api/social/channels', url: '/api/social/channels',
      body: { channels: [{ slug: 'design-reviews', name: 'Design reviews', lastMessagePreview: 'ship it', lastMessageAt: '2026-11-08T10:00:00Z' }] }, ref: 'channel:design-reviews', href: '/social/channels/design-reviews' },
    { tenant: 'orgiq', role: 'member', args: { kind: 'channel' }, prefix: '/api/social/plane/channels', url: '/api/social/plane/channels',
      body: { channels: [{ slug: 'auth', name: 'Auth migration' }] }, ref: 'channel:auth', href: '/iq/communication/channels/auth',
      ctx: { social: { api: '/api/social/plane', unavailable: null, send: async () => {}, presence: null, deliveries: new Map() } } },
  ];
  for (const k of cases) {
    const { fetch, log } = fakeFetch([route('GET', k.prefix, 200, k.body)]);
    const r = await runVoiceTool('list', k.args, toolContext({ fetch, tenant: k.tenant, role: k.role, results: new ResultMemory(), ...(k.ctx ?? {}) }));
    assert.equal(r.outcome, 'done', k.tenant);
    assert.deepEqual(log.map((l) => l.url), [k.url], k.tenant);
    const row = (r.output['rows'] as Array<Record<string, unknown>>)[0]!;
    assert.equal(row['ref'], k.ref, k.tenant);
    assert.equal(row['href'], k.href, k.tenant);
    assert.doesNotMatch(JSON.stringify(r.output), /private reason/);
  }
});

test('get reads a kept row by ordinal or a typed ref: its summary with withheld facts, or one part whose rows are kept in turn', async () => {
  const { fetch, log } = fakeFetch([
    route('GET', '/api/graph/projects/p1/work', 200, [{ id: 'w1', title: 'Rotate keys', status: 'open', projectId: 'p1', assigneeName: 'Ada' }]),
    route('GET', '/api/graph/projects/p1', 200, { id: 'p1', name: 'Alpha', status: 'in_progress', ownerName: 'Ana', agentSpendUsd: '5.45', allocatedUsd: '75', summary: 'Consolidate logins', contributors: [{}, {}] }),
    route('GET', '/api/graph/projects/nope', 404, { error: 'not found' }),
    route('GET', '/api/graph/projects', 200, [{ id: 'p1', name: 'Alpha' }]),
  ]);
  const results = new ResultMemory();
  const c = toolContext({ fetch, results });
  await runVoiceTool('list', { kind: 'initiative' }, c);
  const r = await runVoiceTool('get', { ref: '1' }, c);
  assert.equal(r.outcome, 'done');
  assert.equal(log.at(-1)!.url, '/api/graph/projects/p1');
  assert.equal(r.output['ref'], 'initiative:p1');
  assert.deepEqual(r.output['facts'], { ownerName: 'Ana', summary: 'Consolidate logins', contributorsCount: 2 });
  assert.doesNotMatch(JSON.stringify(r.output), /5\.45|75/, 'money is budget\'s, never get\'s');
  const part = await runVoiceTool('get', { ref: 'initiative:p1', part: 'work' }, c);
  assert.equal(log.at(-1)!.url, '/api/graph/projects/p1/work');
  assert.deepEqual((part.output['rows'] as unknown[])[0], { ref: 'work-item:w1', title: 'Rotate keys', subtitle: 'Ada', status: 'open', href: '/iq/projects/p1' });
  assert.equal(results.find('1')!.ref, 'work-item:w1', 'the part\'s rows are the newest set');
  const missing = await runVoiceTool('get', { ref: 'initiative:nope' }, c);
  assert.equal(missing.outcome, 'refused');
  assert.match(String(missing.output['reason']), /found no initiative with that ref/);
  // A kind from another tenant is not read here.
  assert.equal((await runVoiceTool('get', { ref: 'request:r1' }, c)).outcome, 'refused');
});

test('open { page: computers } opens the Computers page; open { kind: computer, name } opens the initiative\'s running computer on it', async () => {
  const c = toolContext();
  const r = await runVoiceTool('open', { page: 'computers' }, c);
  assert.equal(r.outcome, 'done');
  assert.deepEqual(c.navigations, ['/iq/computers'], 'the one page that lists and starts computers');
  const { fetch } = fakeFetch([route('GET', '/api/devbox/boxes', 200, { boxes: [
    { id: 'c-idle', label: 'alpha-1', project: 'Alpha', status: 'idle' }, { id: 'c-run', label: 'alpha-2', project: 'Alpha', status: 'running' },
    { id: 'c-beta', label: 'beta-1', project: 'Beta', status: 'running' },
  ] })]);
  const focus = toolContext({ fetch, role: 'sme' });
  await runVoiceTool('open', { kind: 'computer', name: 'alpha' }, focus);
  assert.deepEqual(focus.navigations, ['/iq/computers?computer=c-run']);
  const member = await runVoiceTool('open', { page: 'computers' }, toolContext({ role: 'member' }));
  assert.equal(member.outcome, 'done', 'every orgiq role may open Computers: a paired machine is theirs, the lab list follows the lab\'s own read gate');
});

test('open { kind, name }: one match opens in one step, two are a numbered choice kept for "the second one", none points at the nearest page', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/graph/projects', 200, [
    { id: 'p-alpha', name: 'Alpha', ownerName: 'Ana' }, { id: 'p-alpha-2', name: 'Alpha rollout', ownerName: 'Bo' }, { id: 'p-beta', name: 'Beta' },
  ])]);
  const results = new ResultMemory();
  const c = toolContext({ fetch, results });
  const one = await runVoiceTool('open', { kind: 'initiative', name: 'beta' }, c);
  assert.equal(one.outcome, 'done');
  assert.equal(log[0]!.url, '/api/graph/projects?limit=50&scope=all', 'a name is looked for across everything the user reads');
  assert.deepEqual(c.navigations, ['/iq/projects/p-beta']);
  // "Alpha" names one exactly: exact title wins over the looser match.
  await runVoiceTool('open', { kind: 'initiative', name: 'Alpha' }, c);
  assert.equal(c.navigations.at(-1), '/iq/projects/p-alpha');
  const two = await runVoiceTool('open', { kind: 'initiative', name: 'alph' }, c);
  assert.equal(two.output['kind'], 'ambiguous');
  assert.deepEqual(two.output['candidates'], [
    { ref: 'initiative:p-alpha', title: 'Alpha', subtitle: 'Owner: Ana', kind: 'initiative', href: '/iq/projects/p-alpha' },
    { ref: 'initiative:p-alpha-2', title: 'Alpha rollout', subtitle: 'Owner: Bo', kind: 'initiative', href: '/iq/projects/p-alpha-2' },
  ]);
  assert.equal(c.navigations.length, 2, 'an ambiguous name opens nothing');
  await runVoiceTool('open', { ref: '2' }, c);
  assert.equal(c.navigations.at(-1), '/iq/projects/p-alpha-2', '"the second one"');
  const none = await runVoiceTool('open', { kind: 'initiative', name: 'Gamma' }, c);
  assert.equal(none.outcome, 'refused');
  assert.deepEqual(none.output['nearest'], { page: 'initiatives', label: 'Initiatives' });
});

test('open refuses a kept row in another workspace with the workspace switch offer, and a kind the role cannot read before any request', async () => {
  const results = new ResultMemory();
  results.keep([{ ref: 'request:r1', title: 'SME in Work', href: '/access/requests/r1' }, { ref: 'run:r9', title: 'Nightly', href: '/pipelines/runs/r9' }]);
  const c = toolContext({ results });
  for (const ref of ['1', 'request:r1', 'run:r9']) {
    const r = await runVoiceTool('open', { ref }, c);
    assert.equal(r.outcome, 'refused', ref);
    assert.deepEqual(r.output['offer'], { tool: 'open', page: 'workspaces' });
  }
  assert.deepEqual(c.navigations, []);
  // The same row in its own workspace opens.
  const a = toolContext({ tenant: 'access', role: 'requester', results });
  assert.equal((await runVoiceTool('open', { ref: 'request:r1' }, a)).outcome, 'done');
  assert.deepEqual(a.navigations, ['/access/requests/r1']);
  let calls = 0;
  const m = toolContext({ role: 'member', deny: ['ManageBots'], fetch: async () => { calls++; throw new Error('network'); } });
  assert.equal((await runVoiceTool('open', { kind: 'bot', name: 'nightly' }, m)).outcome, 'refused');
  assert.equal(calls, 0);
});

test('spokenOrdinal reads "the second one", "number three", "4" and nothing from a sentence that merely holds a number', () => {
  for (const [t, n] of [['the second one', 2], ['First.', 1], ['number three', 3], ['4', 4], ['the 5th one', 5], ['ten', 10], ['open the tenth', 10], ['option two please', 2]] as const) {
    assert.equal(spokenOrdinal(t), n, t);
  }
  for (const t of ['two of them are wrong', 'I have 3 questions', '', 'eleven', '12', 'none of them']) assert.equal(spokenOrdinal(t), null, t);
});

const NOW = new Date('2026-11-08T12:00:00Z');
const old = '2026-11-01T09:00:00Z';
const recent = '2026-11-08T08:00:00Z';

function sweepFixtures(opts: { failedBot?: boolean; findingAt?: string; failedSweep?: boolean }) {
  return fakeFetch([
    route('GET', '/api/work/sweeps/runs', 200, { runs: opts.failedSweep ? [{ sweep: 'stale_docs', status: 'failed', startedAt: recent, error: 'graph read timed out', findings: null }] : [] }),
    route('GET', '/api/work/findings', 200, { findings: [{ sweep: 'bus_factor', severity: 'warning', title: 'One owner on Alpha', status: 'open', lastSeenAt: opts.findingAt ?? old }] }),
    route('GET', '/api/bots/runs', 200, { runs: [
      { botId: 'b1', status: opts.failedBot ? 'failed' : 'done', startedAt: recent, error: opts.failedBot ? 'model refused' : null },
      { botId: 'b2', status: 'failed', startedAt: old, error: 'old failure' },
    ] }),
    route('GET', '/api/bots', 200, { bots: [{ id: 'b1', name: 'Docs freshness bot' }, { id: 'b2', name: 'Old bot' }] }),
  ]);
}

test('summary sweeps answers "nothing since yesterday" from only older findings and no failed runs', async () => {
  const { fetch, log } = sweepFixtures({});
  const r = await runVoiceTool('summary', '{"kind":"sweeps","since":null}', toolContext({ fetch, role: 'org-leader', now: () => NOW }));
  assert.equal(r.outcome, 'done');
  assert.match(String(r.output['summary']), /^Nothing failed since/);
  assert.match(log.find((l) => l.url.startsWith('/api/work/sweeps/runs'))!.url, /status=failed/);
  assert.equal((r.output['botRuns'] as { count: number }).count, 0);
});

test('summary sweeps names the failed bot, the failed sweep and the new finding', async () => {
  const { fetch } = sweepFixtures({ failedBot: true, failedSweep: true, findingAt: recent });
  const r = await runVoiceTool('summary', { kind: 'sweeps', since: 'yesterday' }, toolContext({ fetch, role: 'program-owner', now: () => NOW }));
  assert.match(r.summary, /Docs freshness bot/);
  assert.doesNotMatch(r.summary, /Old bot/);
  assert.match(r.summary, /1 failed sweep run/);
  assert.match(r.summary, /1 open finding/);
});

test('summary sweeps for a role without the run history reads findings only and says so', async () => {
  const { fetch, log } = sweepFixtures({ failedBot: true });
  const r = await runVoiceTool('summary', { kind: 'sweeps', since: 'yesterday' }, toolContext({ fetch, role: 'member', deny: ['ManageBots'], now: () => NOW }));
  assert.equal(r.outcome, 'done');
  assert.deepEqual(log.map((l) => l.url.split('?')[0]), ['/api/work/findings']);
  assert.ok((r.output['unread'] as string[])[0]!.includes('your role cannot read it'));
  assert.equal((await runVoiceTool('summary', { kind: 'sweeps', since: 'next tuesday' }, toolContext({ fetch, now: () => NOW }))).outcome, 'refused');
});

test('summary pipelines answers "what failed last night" from the failed runs since then, keeps them, and names dead letters', async () => {
  const { fetch, log } = fakeFetch([
    route('GET', '/api/pipelines/runs', 200, { runs: [
      { id: 'run-9', definitionId: 'runbook:nightly-ingest', status: 'failed', startedAt: recent },
      { id: 'run-1', definitionId: 'runbook:old', status: 'failed', startedAt: old },
    ] }),
    route('GET', '/api/pipelines/queues', 200, { queues: [{ name: 'agent-work-dlq', deadLetter: true, snapshot: { ready: 2 } }, { name: 'agent-work', deadLetter: false, snapshot: { ready: 9 } }] }),
  ]);
  const results = new ResultMemory();
  const r = await runVoiceTool('summary', { kind: 'pipelines', since: 'last night' }, toolContext({ fetch, tenant: 'pipelines', role: 'operator', allow: ['ViewPipelines'], now: () => NOW, results }));
  assert.equal(r.outcome, 'done');
  assert.deepEqual(log.map((l) => l.url), ['/api/pipelines/runs?status=failed', '/api/pipelines/queues']);
  assert.equal(r.output['failed'], 1);
  assert.match(r.summary, /^1 failed run since .*; latest: runbook:nightly-ingest$/);
  assert.deepEqual(r.output['deadLetters'], [{ queue: 'agent-work-dlq', waiting: 2 }]);
  assert.equal(results.find('1')!.href, '/pipelines/runs/run-9', '"open the first one"');
});

test('summary: health, work, today (money left to budget), rollup, access and live, each from its page\'s own read', async () => {
  const cases: Array<{ tenant: string; kind: string; prefix: string; body: unknown; summary: RegExp; ctx?: Parameters<typeof toolContext>[0]; absent?: RegExp }> = [
    { tenant: 'orgiq', kind: 'health', prefix: '/api/observability/summary', body: { totalInvocations24h: 335, totalErrors24h: 14, successRate: '95.8', avgLatencyMs: 1347 },
      summary: /^95\.8% of 335 agent runs succeeded in the last 24 hours; 14 errors; 1347 ms on average$/ },
    { tenant: 'orgiq', kind: 'work', prefix: '/api/work/summary', body: { jobs: { queued: 2, running: 1, failed: 8 }, proposals: { pending: 2 }, consults: { pending: 1 }, findings: { open: 5, critical: 0 } },
      summary: /^2 jobs queued, 1 running, 8 failed; 2 proposals pending; 1 consults waiting for an answer; 5 open findings$/ },
    { tenant: 'orgiq', kind: 'today', prefix: '/api/today', body: { items: [{ category: 'review', label: 'Needs review', summary: '1 agent question waiting' }, { category: 'budget', label: 'Budget', summary: '$22.65 of $431.00 spent this month (5%)' }] },
      summary: /^Needs review: 1 agent question waiting$/, absent: /\$|431/ },
    { tenant: 'assessment', kind: 'rollup', prefix: '/api/assessment/rollup', body: { target_level: 3, teams_total: 7, dimensions_assessed: 55, at_or_above_target: 35, claims_open: 28 },
      summary: /^7 teams; 35 of 55 assessed dimensions at or above level 3; 28 open claims$/ },
    { tenant: 'access', kind: 'access', prefix: '/api/access/summary', body: { openRequests: 2, pendingForMe: 1, activeElevations: 0, policies: 4, reviews: 1 },
      summary: /^2 open requests, 1 waiting on you; 0 active elevations; 1 open review$/ },
    { tenant: 'pipelines', kind: 'live', prefix: '/api/social/plane/active', body: { counts: { people: 17, inCall: 2, sharing: 0 } }, summary: /^17 people online, 2 in a call$/,
      ctx: { social: { api: '/api/social/plane', unavailable: null, send: async () => {}, presence: null, deliveries: new Map() } } },
  ];
  for (const k of cases) {
    const { fetch, log } = fakeFetch([route('GET', k.prefix, 200, k.body)]);
    const r = await runVoiceTool('summary', { kind: k.kind }, toolContext({ fetch, tenant: k.tenant, role: 'org-leader', ...(k.ctx ?? {}) }));
    assert.equal(r.outcome, 'done', k.kind);
    assert.deepEqual(log.map((l) => l.url), [k.prefix], k.kind);
    assert.match(r.summary, k.summary, k.kind);
    if (k.absent) assert.doesNotMatch(JSON.stringify(r.output) + r.summary, k.absent, `${k.kind} carries no money`);
  }
  // A kind another tenant has is refused before the network.
  assert.equal((await runVoiceTool('summary', { kind: 'pipelines' }, toolContext())).outcome, 'refused');
});

// ── budget (V2-7): money at the tier, the offer below it, never a figure in a refusal ──

const FIGURE = 12345.67;
const FIGURES = /12345|12,345|\$/;
function moneyFixtures(belowTier: boolean) {
  const lockedBody = { requestItemId: 'capability:orgiq:budgets-read', visible: false, reason: 'tier' };
  return fakeFetch([
    route('GET', '/api/me/spend', 200, { period: 'month', knownUsd: 3.5, unknownCount: 0, byInitiative: [{ initiativeId: 'p1', initiativeName: 'Alpha', knownUsd: 3.5 }], budget: null }),
    route('GET', '/api/graph/projects', 200, [{ id: 'p1', name: 'Alpha migration' }, { id: 'p2', name: 'Beta' }, { id: 'p3', name: 'Alpha rollout' }]),
    route('GET', '/api/spend/report', 200, belowTier
      ? { totals: { unknownCount: 0, entries: 47 }, groups: [{ key: 'p-auth-migration', label: 'Alpha migration', entries: 7 }], budgetAccess: lockedBody }
      : { totals: { knownUsd: FIGURE, burnPerDay7d: 1.25, projectedPeriodEndUsd: 40.5 }, groups: [{ key: 'p-auth-migration', label: 'Auth Migration', knownUsd: 9.72 }] }),
    ...(belowTier
      ? ['/api/budgets', '/api/user-budgets', '/api/ops/switches'].map((p) => route('GET', p, 403, { error: 'Forbidden', action: 'ManageBudgets', amountUsd: FIGURE }))
      : [route('GET', '/api/budgets', 200, { budgets: [{ orgProjectName: 'Alpha migration', allocatedUsd: 75, spentThisPeriodUsd: 5.45 }] }),
        route('GET', '/api/user-budgets', 200, { budgets: [{ displayName: 'Ada', spentUsd: 8.46 }] }),
        route('GET', '/api/ops/switches', 200, { switches: [{ scope: 'fleet', paused: true }] })]),
    route('GET', '/api/sprints/envelopes', 200, { envelopes: [] }),
    route('GET', '/api/observability/cost/summary', 200, { windowHours: 24, sections: { total: { totalCostUsd: FIGURE }, perAgent: { byAgent: [{ agentId: 'orgiq-supervisor', totalCostUsd: 0.15 }] } } }),
  ]);
}

test('budget: a member hears their own spend and the access request offer, and every wider scope refuses with the offer and no figure', async () => {
  const { fetch, log } = moneyFixtures(true);
  const c = toolContext({ fetch, role: 'member', deny: ['ManageBudgets'] });
  const me = await runVoiceTool('budget', { scope: 'me' }, c);
  assert.equal(me.outcome, 'done');
  assert.equal(me.summary, 'You spent $3.50 this month');
  assert.deepEqual(me.output['rows'], [{ title: 'Alpha', spentUsd: 3.5 }]);
  const more = me.output['more'] as { hint: { href: string; item: string }; offer: unknown };
  assert.equal(more.hint.href, '/access/requests/new?item=capability%3Aorgiq%3Abudgets-read');
  assert.deepEqual(more.offer, { tool: 'open', page: 'workspaces' });
  for (const args of [{ scope: 'initiative', initiative: 'Alpha migration' }, { scope: 'org' }, { scope: 'allocations' }, { scope: 'users' }, { scope: 'switches' }, { scope: 'cost' }]) {
    const r = await runVoiceTool('budget', args, c);
    assert.equal(r.outcome, 'refused', JSON.stringify(args));
    assert.equal(r.output['reason'], 'Spend and allocation figures are visible to the budgets read tier. I can open the access request.');
    assert.equal((r.output['hint'] as { item: string }).item, 'capability:orgiq:budgets-read');
    assert.doesNotMatch(JSON.stringify(r.output) + r.summary, FIGURES, `${JSON.stringify(args)}: no figure in a refusal`);
  }
  assert.ok(!log.some((l) => l.url.startsWith('/api/observability/cost')), 'the cost console is never read below the tier');
  // Outside orgiq only the caller's own spend exists, and no offer (there is no tier there).
  const p = await runVoiceTool('budget', { scope: 'me' }, toolContext({ fetch, tenant: 'pipelines', role: 'operator' }));
  assert.equal(p.outcome, 'done');
  assert.equal(p.output['more'], undefined);
  assert.equal((await runVoiceTool('budget', { scope: 'org' }, toolContext({ fetch, tenant: 'pipelines' }))).outcome, 'refused');
});

test('budget: a program owner hears Alpha\'s spend by person, the org\'s pace, allocations and switches; two Alphas are a question', async () => {
  const { fetch, log } = moneyFixtures(false);
  const c = toolContext({ fetch, role: 'program-owner' });
  const one = await runVoiceTool('budget', { scope: 'initiative', initiative: 'alpha migration' }, c);
  assert.equal(one.outcome, 'done');
  assert.equal(log.at(-1)!.url, '/api/spend/report?groupBy=actor&initiativeId=p1');
  assert.equal(one.summary, `Alpha migration spent $${FIGURE.toFixed(2)} this month; on pace for $40.50; most: Auth Migration at $9.72`);
  const two = await runVoiceTool('budget', { scope: 'initiative', initiative: 'Alpha' }, c);
  assert.equal(two.output['kind'], 'ambiguous');
  assert.deepEqual((two.output['candidates'] as Array<{ title: string }>).map((x) => x.title), ['Alpha migration', 'Alpha rollout']);
  assert.match((await runVoiceTool('budget', { scope: 'allocations', initiative: 'alpha' }, c)).summary, /^Alpha migration: \$5\.45 spent of \$75\.00$/);
  assert.equal((await runVoiceTool('budget', { scope: 'switches' }, c)).summary, 'Paused: fleet');
  assert.match((await runVoiceTool('budget', { scope: 'cost' }, c)).summary, /^Agent runs cost \$12345\.67 in the last 24 hours; most: orgiq-supervisor at \$0\.15$/);
  // The route's withheld fields stay absent: a body with no figures is a failure, never $0.
  const blank = fakeFetch([route('GET', '/api/spend/report', 200, { totals: { entries: 3 }, groups: [] })]);
  const b = await runVoiceTool('budget', { scope: 'org' }, toolContext({ fetch: blank.fetch, role: 'org-leader' }));
  assert.equal(b.outcome, 'failed');
  assert.doesNotMatch(b.summary, /\$/);
});

test('parseSince reads yesterday as local midnight and refuses the future', () => {
  const now = new Date(2026, 10, 8, 15, 30);
  assert.equal(parseSince('yesterday', now)!.getTime(), new Date(2026, 10, 7).getTime());
  assert.equal(parseSince('2026-11-01', now)!.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(parseSince('2026-12-01', now), null);
  // G9: "last night" is yesterday, "this morning" today, "N hours ago" counts back from now.
  assert.equal(parseSince('Last night', now)!.getTime(), new Date(2026, 10, 7).getTime());
  assert.equal(parseSince('this morning', now)!.getTime(), new Date(2026, 10, 8).getTime());
  assert.equal(parseSince('3 hours ago', now)!.getTime(), new Date(2026, 10, 8, 12, 30).getTime());
  assert.equal(parseSince('1 hour ago', now)!.getTime(), new Date(2026, 10, 8, 14, 30).getTime());
  assert.equal(parseSince('2 days ago', now)!.getTime(), now.getTime() - 2 * 24 * 3600_000);
  assert.equal(parseSince('3 hours ago; rm -rf /', now), null);
});

const request = (over: Record<string, unknown>) => ({
  id: 'r1', kind: 'grant', reviewId: null, requester: { id: 'u1', displayName: 'Me' }, beneficiary: { id: 'u1', displayName: 'Me' },
  item: { id: 'envelope:p1', title: 'Sprint envelope on Alpha' }, justification: 'my private reason for asking', duration: 'standing',
  status: 'pending', submittedAt: '2026-11-07T10:00:00Z',
  steps: [{ step: 1, kind: 'manager', status: 'approved', decidedBy: { id: 'm', displayName: 'Maya Manager' }, decidedAt: '2026-11-07T11:00:00Z', eligible: [] },
    { step: 2, kind: 'steward', status: 'current', eligible: [{ id: 's', displayName: 'Sam Steward' }] }],
  sod: { verdict: 'clear', conflicts: [] }, ...over,
});

test('access_request_status reads scope=mine only, even for an approver, in the access tenant', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/access/requests', 200, { items: [request({})] })]);
  const r = await runVoiceTool('access_request_status', { query: 'envelope' }, toolContext({ fetch, tenant: 'access', role: 'approver' }));
  assert.equal(log.length, 1);
  assert.equal(log[0]!.url, '/api/access/requests?scope=mine&q=envelope');
  const row = (r.output['rows'] as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(row, { ref: 'request:r1', item: 'Sprint envelope on Alpha', status: 'pending', submittedAt: '2026-11-07T10:00:00Z', currentStep: 'steward', waitingOn: 'Sam Steward', decidedBy: 'Maya Manager', decidedAt: '2026-11-07T11:00:00Z' });
  assert.doesNotMatch(JSON.stringify(r.output), /private reason/, 'the justification never reaches the model');
});

test('access_request_status: an approver reads what waits on them, a manager their reports\' requests, and each opens by ref', async () => {
  const waiting = [
    request({ id: 'r-ada', requester: { id: 'u-ada', displayName: 'Ada Okafor' }, beneficiary: { id: 'u-ada', displayName: 'Ada Okafor' }, item: { id: 'orgiq:sme', title: 'SME in Work' }, submittedAt: '2026-11-08T09:00:00Z' }),
    request({ id: 'r-bo', requester: { id: 'u-bo', displayName: 'Bo Lin' }, beneficiary: { id: 'u-bo', displayName: 'Bo Lin' }, item: { id: 'social:moderator', title: 'Moderator in Social' } }),
  ];
  const { fetch, log } = fakeFetch([
    route('GET', '/api/access/approvals', 200, { items: waiting }),
    route('GET', '/api/access/requests?scope=reports', 200, { items: [waiting[1]] }),
  ]);
  const results = new ResultMemory();
  const c = toolContext({ fetch, tenant: 'access', role: 'approver', allow: ['ViewAccess', 'RequestAccess', 'DecideAccess'], results });
  const all = await runVoiceTool('access_request_status', '{"query":null,"scope":"approvals"}', c);
  assert.equal(all.outcome, 'done');
  assert.equal(log[0]!.url, '/api/access/approvals');
  assert.equal(all.summary, '2 waiting on you; first: SME in Work from Ada Okafor');
  assert.deepEqual((all.output['rows'] as Array<Record<string, unknown>>).map((r) => [r['ref'], r['requester']]), [['request:r-ada', 'Ada Okafor'], ['request:r-bo', 'Bo Lin']]);
  assert.doesNotMatch(JSON.stringify(all.output), /private reason/, 'the justification never reaches the model');
  const bo = await runVoiceTool('access_request_status', { query: 'bo lin', scope: 'approvals' }, c);
  assert.equal(bo.output['count'], 1, 'the route\'s own match, over requester and item');
  const reports = await runVoiceTool('access_request_status', { scope: 'reports' }, c);
  assert.equal(log.at(-1)!.url, '/api/access/requests?scope=reports');
  assert.equal(reports.summary, 'Moderator in Social: pending');
  // The kept rows open the request's own record page.
  assert.equal((await runVoiceTool('open', { ref: 'request:r-bo' }, c)).outcome, 'done');
  assert.deepEqual(c.navigations, ['/access/requests/r-bo']);
  const nav = toolContext({ tenant: 'access', role: 'requester' });
  await runVoiceTool('open', { page: 'requests', params: { id: 'r-bo' } }, nav);
  assert.deepEqual(nav.navigations, ['/access/requests/r-bo']);
  // The approvals page is the approver's palette row; a requester is not offered it.
  const asRequester = toolContext({ tenant: 'access', role: 'requester' });
  assert.equal((await runVoiceTool('open', { page: 'approvals' }, asRequester)).outcome, 'refused');
});

test('access_request_status outside Access refuses approvals and reports with the Access hint, before any request', async () => {
  for (const tenant of ['orgiq', 'social', 'assessment', 'pipelines']) {
    let calls = 0;
    const r = await runVoiceTool('access_request_status', { scope: 'approvals' }, toolContext({ tenant, fetch: async () => { calls++; throw new Error('network'); } }));
    assert.equal(r.outcome, 'refused', tenant);
    assert.match(String(r.output['hint']), /Access workspace/, tenant);
    assert.equal(calls, 0, tenant);
  }
});

test('access_request_status from orgiq resolves an initiative name to its envelope and reads /mine', async () => {
  const { fetch, log } = fakeFetch([
    route('GET', '/api/graph/projects', 200, [{ id: 'p1', name: 'Alpha migration' }, { id: 'p2', name: 'Beta' }]),
    route('GET', '/api/access-requests/mine', 200, { items: [request({ status: 'approved' })] }),
  ]);
  const r = await runVoiceTool('access_request_status', { query: 'the alpha envelope' }, toolContext({ fetch }));
  assert.deepEqual(log.map((l) => l.url), ['/api/graph/projects?scope=mine&limit=50', '/api/access-requests/mine?itemId=envelope%3Ap1']);
  assert.equal(r.summary, 'Sprint envelope on Alpha: approved');
  const none = await runVoiceTool('access_request_status', { query: 'prod database' }, toolContext({ fetch: fakeFetch([route('GET', '/api/graph/projects', 200, [])]).fetch }));
  assert.match(String(none.output['hint']), /Access workspace/);
});

test('property: no tool result carries a string over 120 characters or a list over 10 rows', async () => {
  const huge = 'x'.repeat(5000);
  const rows = (n: number, f: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, i) => f(i));
  const { fetch } = fakeFetch([
    route('GET', '/api/search', 200, { results: rows(50, (i) => ({ title: huge + i, subtitle: huge, description: huge, href: `/${huge}`, matchReason: huge, type: huge })), total: 50 }),
    route('GET', '/api/graph/projects', 200, rows(60, (i) => ({ id: `p${i}-${huge}`, name: `Alpha ${huge}`, ownerName: huge, contributorCount: i }))),
    route('GET', '/api/work/sweeps/runs', 200, { runs: rows(40, () => ({ sweep: huge, status: 'failed', startedAt: recent, error: huge })) }),
    route('GET', '/api/work/findings', 200, { findings: rows(40, () => ({ sweep: huge, severity: 'critical', title: huge, status: 'open', lastSeenAt: recent })) }),
    route('GET', '/api/bots/runs', 200, { runs: rows(40, (i) => ({ botId: `b${i}`, status: 'failed', startedAt: recent, error: huge })) }),
    route('GET', '/api/bots', 200, { bots: rows(40, (i) => ({ id: `b${i}`, name: `${huge}${i}` })) }),
    route('GET', '/api/access-requests/mine', 200, { items: rows(30, () => request({ item: { id: 'e', title: huge } })) }),
  ]);
  const calls: Array<[string, Record<string, unknown>]> = [
    ['search', { query: 'k', type: 'person', limit: 10 }], ['search', { query: 'k', limit: 10 }], ['list', { kind: 'initiative', filter: { scope: 'all' }, limit: 10 }],
    ['summary', { kind: 'sweeps', since: 'yesterday' }], ['access_request_status', { query: 'alpha' }], ['open', { page: 'search', params: { q: huge.slice(0, 900) } }],
  ];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') assert.ok(v.length <= MAX_FIELD_CHARS, `${path} is ${v.length} characters`);
    else if (Array.isArray(v)) { assert.ok(v.length <= MAX_ROWS, `${path} has ${v.length} rows`); v.forEach((x, i) => walk(x, `${path}[${i}]`)); }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  for (const [name, args] of calls) {
    const r = await runVoiceTool(name, args, toolContext({ fetch, role: 'org-leader', now: () => NOW }));
    assert.equal(r.outcome, 'done', name);
    walk(r.output, name);
    assert.ok(r.summary.length <= MAX_FIELD_CHARS);
  }
  walk(shapeOutput({ deep: { deeper: [Array.from({ length: 30 }, () => huge)] } }), 'shapeOutput');
});

test('the catalogue has a runner for every tool', async () => {
  const { VOICE_RUNNERS } = await import('../actions.ts');
  assert.deepEqual(Object.keys(VOICE_RUNNERS).sort(), VOICE_TOOLS.map((t) => t.name).sort());
});

// ── G50: near-match names ──

test('G50 nameScore: case, punctuation, plurals and run-together words are the same name; a near name scores at least 0.5', async () => {
  const { nameScore, NEAR_MATCH, kindWords } = await import('../tools.ts');
  assert.equal(nameScore('Onboarding flow', 'on-boarding flow'), 1);
  assert.equal(nameScore('Dashboard', 'dashboards'), 1);
  assert.equal(nameScore('Résumé review', 'resume review'), 1);
  assert.ok(nameScore('Onboarding flow', 'the on-boarding work item', kindWords('work-item', 'work items')) >= NEAR_MATCH);
  assert.ok(nameScore('general-chat', 'general', kindWords('channel', 'channels')) >= NEAR_MATCH);
  assert.ok(nameScore('Rotate the signing keys', 'on-boarding') < NEAR_MATCH);
  assert.equal(nameScore('Anything', ''), 0);
});

test('G50 + G62 acceptance: "open the on-boarding work item" opens "Onboarding flow", the one near name, and says so; two near names are a choice; "open channel general" with #general-chat opens it', async () => {
  const { fetch } = fakeFetch([route('GET', '/api/graph/work', 200, [
    { id: 'w-9', title: 'Onboarding flow', projectId: 'p-auth' }, { id: 'w-2', title: 'Rotate the signing keys', projectId: 'p-auth' },
  ])]);
  const c = toolContext({ fetch, results: new ResultMemory() });
  const work = await runVoiceTool('open', { kind: 'work-item', name: 'the on-boarding work item' }, c);
  // G62: one candidate is not a choice: it opens, and the line names it as the nearest.
  assert.equal(work.output['kind'], 'navigated', 'not not-found, and not a one-row choice');
  assert.equal(work.output['say'], 'Opened Onboarding flow, the nearest to "the on-boarding work item".');
  assert.equal(work.output['stop'], true);
  assert.deepEqual(c.navigations, ['/iq/projects/p-auth']);
  // The same name in other words opens at once.
  await runVoiceTool('open', { kind: 'work-item', name: 'on-boarding flow' }, c);
  assert.deepEqual(c.navigations, ['/iq/projects/p-auth', '/iq/projects/p-auth']);
  // Two near names stay a choice; nothing opens until the user picks.
  const { fetch: two } = fakeFetch([route('GET', '/api/graph/work', 200, [
    { id: 'w-9', title: 'Onboarding flow', projectId: 'p-auth' }, { id: 'w-8', title: 'Onboarding docs', projectId: 'p-auth' },
  ])]);
  const c2 = toolContext({ fetch: two, results: new ResultMemory() });
  const both = await runVoiceTool('open', { kind: 'work-item', name: 'onboarding' }, c2);
  assert.equal(both.output['kind'], 'ambiguous');
  assert.deepEqual((both.output['candidates'] as Array<Record<string, unknown>>).map((x) => x['title']), ['Onboarding flow', 'Onboarding docs']);
  assert.deepEqual(c2.navigations, []);
  const social = { api: '/api/social/plane', unavailable: null, send: async () => {}, presence: null, deliveries: new Map() };
  const { fetch: ch } = fakeFetch([route('GET', '/api/social/plane/channels', 200, { channels: [{ slug: 'general-chat', name: 'general-chat' }, { slug: 'design', name: 'Design reviews' }] })]);
  const chat = toolContext({ fetch: ch, results: new ResultMemory(), social });
  const general = await runVoiceTool('open', { kind: 'channel', name: 'general' }, chat);
  assert.equal(general.output['kind'], 'navigated', 'G62: the one near channel opens');
  assert.equal(general.output['title'], 'general-chat');
  assert.equal(chat.navigations.length, 1);
  // Nothing near: not-found, naming the three closest rows of the kind.
  const none = await runVoiceTool('open', { kind: 'channel', name: 'zebra' }, chat);
  assert.equal(none.outcome, 'refused');
  assert.equal(none.output['code'], 'not-found');
  assert.deepEqual((none.output['closest'] as Array<Record<string, unknown>>).map((x) => x['title']).sort(), ['Design reviews', 'general-chat']);
});

test('G50: findByName and matchByName offer near names instead of not-found', async () => {
  const { findByName } = await import('../tools.ts');
  const { matchByName } = await import('../work.ts');
  const { fetch } = fakeFetch([route('GET', '/api/graph/work', 200, [{ id: 'w-9', title: 'Onboarding flow', projectId: 'p-auth' }, { id: 'w-2', title: 'Rotate keys', projectId: 'p-auth' }])]);
  const found = await findByName(toolContext({ fetch, results: new ResultMemory() }), 'work-item', 'onboard docs');
  assert.ok('result' in found && found.result.output['kind'] === 'ambiguous');
  assert.deepEqual(('result' in found ? found.result.output['candidates'] as Array<Record<string, unknown>> : []).map((x) => x['ref']), ['work-item:w-9']);
  const same = await findByName(toolContext({ fetch, results: new ResultMemory() }), 'work-item', 'On-Boarding Flows');
  assert.ok('row' in same && same.row.id === 'w-9', 'the same name in other words is the row');
  const bots = [{ name: 'Nightly dependency sweep' }, { name: 'Docs linter' }];
  assert.deepEqual(matchByName(bots, (b) => b.name, 'dependency sweeps').map((b) => b.name), ['Nightly dependency sweep']);
  assert.deepEqual(matchByName(bots, (b) => b.name, 'doc-linter').map((b) => b.name), ['Docs linter']);
  assert.deepEqual(matchByName(bots, (b) => b.name, 'zebra'), []);
});

test('S4: a write from a call resolves its record exactly', async () => {
  const { findByName, STRICT_SENTENCE } = await import('../tools.ts');
  const rows = [{ id: 'w-9', title: 'Onboarding flow', projectId: 'p-auth' }, { id: 'w-2', title: 'Rotate keys', projectId: 'p-auth' }, { id: 'w-3', title: 'Rotate keys', projectId: 'p-auth' }];
  const { fetch } = fakeFetch([route('GET', '/api/graph/work', 200, rows)]);
  const strict = () => { const resolvedTargets: Array<{ ref: string; title: string }> = []; return { resolvedTargets, ctx: toolContext({ fetch, results: new ResultMemory(), strictTargets: true, resolvedTargets }) }; };
  const hit = strict();
  const exact = await findByName(hit.ctx, 'work-item', '  onboarding FLOW ');
  assert.ok('row' in exact && exact.row.id === 'w-9', 'an exact title, ignoring case and spaces, is the row');
  assert.deepEqual(hit.resolvedTargets, [{ ref: 'work-item:w-9', title: 'Onboarding flow' }]);
  const typed = await findByName(strict().ctx, 'work-item', 'work-item:w-2');
  assert.ok('row' in typed && typed.row.id === 'w-2', 'a typed reference is the row');
  for (const said of ['2', 'onboarding', 'onboard docs', 'Rotate keys', '']) {
    const refused = await findByName(strict().ctx, 'work-item', said);
    assert.ok('result' in refused, `"${said}" is refused`);
    assert.equal(('result' in refused ? refused.result.summary : ''), STRICT_SENTENCE);
  }
  const loose = await findByName(toolContext({ fetch, results: new ResultMemory() }), 'work-item', 'onboarding');
  assert.ok('row' in loose, 'the voice navigator keeps its looser matching');
});

test('S4: update, decide and attach refuse a position from a call', async () => {
  const { positionRefusal, STRICT_SENTENCE } = await import('../tools.ts');
  const { fetch } = fakeFetch([]);
  const strict = toolContext({ fetch, results: new ResultMemory(), strictTargets: true });
  assert.equal(positionRefusal(strict, ' 2 ')?.summary, STRICT_SENTENCE);
  assert.equal(positionRefusal(strict, 'work-item:w-2'), null);
  assert.equal(positionRefusal(toolContext({ fetch, results: new ResultMemory() }), '2'), null, 'the voice navigator keeps positions');
});
