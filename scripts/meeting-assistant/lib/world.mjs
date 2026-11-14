// The world a scenario runs in: a fresh middleware (mock world, meeting assistant on) with its safety limits, the fake provider and
// media server (or the pass-through proxy for the paid drop scenario), the people with their browser stand-ins, one call with Nova in it,
// and the check classes. See safety.mjs for how a run always ends.
//
//   harness(name, ok, detail)  plumbing that must hold: a failure means the harness is wrong
//   expect(name, ok, detail)   product behaviour we require: a failure is a FINDING about the product
//   measure(name, value)       numbers only
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Guard, DEADMAN_PATH, deadmanMsFor, maxMinutesFor, PRICE_PER_MINUTE } from './safety.mjs';
import { FakeProvider, PassThroughProxy, startFakeMedia } from './fakes.mjs';
import { Lane } from './audio.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const MW = path.join(ROOT, 'middleware');
export const SINK_SECRET = 'dry-sink-secret';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const stamp = () => Date.now().toString(36);

/** The ports one run uses, from its base (default 3953): middleware, provider, media, proxy, spare. */
export const portsFor = (base = 3953) => ({ mw: base, provider: base + 1, media: base + 2, proxy: base + 3, spare: base + 4 });

// ── The people: real mock-world users, with the voice each speaks in ──────────────────────────────────────
export const PEOPLE = {
  vera: { userId: 'u-vera', role: 'org-leader', voice: 'Samantha', name: 'Vera' },
  nora: { userId: 'u-nora', role: 'sme', voice: 'Daniel', name: 'Nora' },
  mia: { userId: 'u-mia', role: 'program-owner', voice: 'Karen', name: 'Mia' },
  layla: { userId: 'u-layla', role: 'sme', voice: 'Moira', name: 'Layla' },
};

// ── The check classes ─────────────────────────────────────────────────────────────────────────────────────
export class Reporter {
  constructor() { this.scenarios = []; this.cur = null; }
  begin(id) { this.cur = { id, harness: [], expects: [], measures: [], notes: [] }; this.scenarios.push(this.cur); console.log(`\n== ${id}`); return this.cur; }
  harness = (name, ok, detail = '') => { this.cur.harness.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} [harness] ${name}${detail ? `: ${detail}` : ''}`); return !!ok; };
  expect = (name, ok, detail = '') => { this.cur.expects.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} [expect]  ${name}${detail ? `: ${detail}` : ''}`); return !!ok; };
  measure = (name, value) => { this.cur.measures.push({ name, value }); console.log(`     [measure] ${name} = ${typeof value === 'number' ? Math.round(value * 100) / 100 : JSON.stringify(value)}`); };
  note = (text) => { this.cur.notes.push(text); console.log(`     [note]    ${text}`); };
  get failedHarness() { return this.scenarios.flatMap((s) => s.harness.filter((c) => !c.ok).map((c) => ({ scenario: s.id, ...c }))); }
  get findings() { return this.scenarios.flatMap((s) => s.expects.filter((c) => !c.ok).map((c) => ({ scenario: s.id, ...c }))); }
  table() {
    console.log('\nscenario                 harness     expects     measures');
    for (const s of this.scenarios) {
      const h = `${s.harness.filter((c) => c.ok).length}/${s.harness.length}`, e = `${s.expects.filter((c) => c.ok).length}/${s.expects.length}`;
      console.log(`${s.id.padEnd(24)} ${h.padEnd(11)} ${e.padEnd(11)} ${s.measures.length}`);
    }
    const f = this.findings;
    console.log(`\nFINDINGS (${f.length})`);
    for (const x of f) console.log(`  - ${x.scenario}: ${x.name}${x.detail ? ` (${x.detail})` : ''}`);
    const bad = this.failedHarness;
    if (bad.length) { console.log(`\nHARNESS FAILURES (${bad.length})`); for (const x of bad) console.log(`  - ${x.scenario}: ${x.name}${x.detail ? ` (${x.detail})` : ''}`); }
  }
  json() { return this.scenarios.map((s) => ({ id: s.id, harness: s.harness, expects: s.expects, measures: s.measures, notes: s.notes })); }
}

// ── The middleware child ──────────────────────────────────────────────────────────────────────────────────
export function startMiddleware({ dir, ports, dry, limitSeconds, useProxy = false, sinkBase }) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'development',
    INSECURE_DEV_MODE: 'true', AUTH_DEMO_MODE: 'true', DEV_OFFLINE: 'true', SPEND_HOLDS_UNATTRIBUTED: 'allow',
    MOCK_AURORA: 'true', MOCK_AGENTCORE: 'true', MOCK_GUARDRAILS: 'true', MOCK_CLOUDWATCH: 'true', MOCK_QUEUE: 'true',
    POLICY_STORE_ID: '', SESSION_SIGNING_SECRET_ARN: '', COGNITO_USER_POOL_ID: '', COGNITO_CLIENT_ID: '', COGNITO_CLIENT_SECRET: '', COGNITO_DOMAIN: '', COGNITO_CALLBACK_URL: '',
    PORT: String(ports.mw), MEETING_ASSISTANT_ENABLED: 'true', MEETING_ASSISTANT_LIVE: '1', VOICE_LOG_DIR: path.join(dir, 'voice-log'),
    // The safety: the server ends the session by itself one minute after the scenario's limit, and the preload ends the whole process.
    MEETING_ASSISTANT_MAX_MINUTES: String(maxMinutesFor(limitSeconds)),
    NODE_OPTIONS: `--require ${DEADMAN_PATH}`, MA_DEADMAN_MS: String(deadmanMsFor(limitSeconds)),
    ...(dry ? {
      OPENAI_API_KEY: 'dry-run-key', OPENAI_BASE_URL: `http://127.0.0.1:${ports.provider}/v1`,
      MEETING_ASSISTANT_MEDIA_URL: `http://127.0.0.1:${ports.media}`, MEETING_ASSISTANT_MEDIA_ADMIN_TOKEN: 'dry-admin-token', MEETING_ASSISTANT_SINK_BASE_URL: sinkBase, MEETING_ASSISTANT_SINK_SECRET: SINK_SECRET,
    } : (useProxy ? { OPENAI_BASE_URL: `http://127.0.0.1:${ports.proxy}/v1` } : {})), // paid: the key is read by the middleware itself from its own env file
  };
  const logFile = fs.openSync(path.join(dir, 'middleware.log'), 'w');
  return spawn(process.execPath, [path.join(MW, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'], { cwd: MW, env, stdio: ['ignore', logFile, logFile] });
}

export async function waitHealthy(child, base, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`the middleware exited with ${child.exitCode}`);
    try { const r = await fetch(`${base}/api/health`); if (r.status < 500) return; } catch { /* not yet */ }
    await sleep(500);
  }
  throw new Error('the middleware did not come up in time');
}
export const tailLog = (dir, n = 15) => { try { return fs.readFileSync(path.join(dir, 'middleware.log'), 'utf8').split('\n').slice(-n).join('\n'); } catch { return ''; } };

// ── One person's browser stand-in ─────────────────────────────────────────────────────────────────────────
export class Person {
  constructor(p, base, port) {
    this.p = p; this.base = base; this.port = port; this.cookies = new Map(); this.ws = null; this.frames = [];
    this.audioFrames = 0; this.audioKeep = null; this.audioLast = false;
  }
  get userId() { return this.p.userId; }
  get name() { return this.p.name; }
  async call(method, url, body) {
    const res = await fetch(`${this.base}${url}`, { method, headers: { 'content-type': 'application/json', cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) this.cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  }
  async signIn() {
    const login = await this.call('POST', '/api/session/login', { userId: this.p.userId });
    if (login.status !== 200) throw new Error(`login ${this.p.userId}: ${login.status}`);
    const role = await this.call('POST', '/api/session/role', { tenant: 'orgiq', role: this.p.role });
    if (role.status !== 200) throw new Error(`role ${this.p.role}: ${role.status}`);
    const tok = await this.call('GET', '/api/session/realtime-token');
    if (tok.status !== 200 || !tok.json?.token) throw new Error(`realtime token ${this.p.userId}: ${tok.status}`);
    this.realtime = tok.json.token;
  }
  /** The chat socket. Chat and notification frames are kept; `assistant-audio` frames are only counted (and held in memory when `audioKeep` is an array). */
  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`, ['bearer-token-v1', this.realtime]);
    this.ws.addEventListener('message', (e) => {
      let f; try { f = JSON.parse(String(e.data)); } catch { return; }
      if (f?.type === 'assistant-audio') { this.audioFrames += 1; if (this.keepAudioFrames) this.frames.push(f); this.audioHook?.(f.data); if (Array.isArray(this.audioKeep)) this.audioKeep.push(f.data); return; }
      this.frames.push(f); if (this.frames.length > 4000) this.frames.splice(0, 1000);
    });
    await new Promise((resolve, reject) => { this.ws.addEventListener('open', () => resolve()); this.ws.addEventListener('error', () => reject(new Error('socket refused'))); });
    await this.waitFrame((f) => f.type === 'session', 10_000);
  }
  send(frame) { this.ws.send(JSON.stringify(frame)); }
  async waitFrame(pred, ms = 15_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const f = this.frames.find(pred); if (f) return f; await sleep(100); }
    throw new Error('an expected frame never arrived');
  }
  close() { try { this.ws?.close(); } catch { /* closed */ } this.stopTurns?.(); }

  /**
   * The private answers this person received: what the browser's toast (NovaPrivateAnswers.tsx) shows is the notification
   * of type `assistant-private-reply` for the call, delivered on this person's own gateway socket. Texts only.
   */
  privateAnswers(callId) {
    const out = [];
    const seen = new Set();
    const walk = (o, hit) => {
      if (!o || typeof o !== 'object') return;
      if (o.type === 'assistant-private-reply' || o.kind === 'assistant-private-reply') hit = true;
      if (hit && typeof o.body === 'string' && !seen.has(o.id ?? o.body)) { seen.add(o.id ?? o.body); out.push(o.body); }
      for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, hit);
    };
    for (const f of this.frames) { const s = JSON.stringify(f); if (s.includes('assistant-private-reply') && (!callId || s.includes(callId))) walk(f, false); }
    return out;
  }

  /**
   * A turn runner: polls this person's turns, claims each, and posts what `decide(turn)` says. `decide` returns
   * { ok, say, error, delayMs } to answer (after delayMs), { withhold: true } to never claim it, or a promise of either.
   * Turns are handled independently, so a delayed one does not hold up the next.
   */
  runTurns(callId, decide) {
    const A = `/api/calls/${encodeURIComponent(callId)}/assistant`;
    const log = []; const taken = new Set(); let on = true;
    const loop = (async () => {
      while (on) {
        const turns = (await this.call('GET', `${A}/turns?mine=1`).catch(() => null))?.json?.turns ?? [];
        for (const t of turns) {
          if (taken.has(t.turnId)) continue;
          taken.add(t.turnId);
          void (async () => {
            const d = await decide(t);
            if (!d || d.withhold) { log.push({ turnId: t.turnId, tool: t.tool?.name, kind: t.kind, withheld: true, at: Date.now() }); return; }
            const claim = await this.call('POST', `${A}/turns/${encodeURIComponent(t.turnId)}/claim`);
            if (claim.status !== 200) { log.push({ turnId: t.turnId, tool: t.tool?.name, claim: claim.status, at: Date.now() }); return; }
            if (d.delayMs) await sleep(d.delayMs);
            const body = d.ok === false ? { claimId: claim.json.claimId, ok: false, error: d.error ?? 'it did not work' } : { claimId: claim.json.claimId, ok: true, output: { say: d.say ?? 'Done.' } };
            const posted = await this.call('POST', `${A}/turns/${encodeURIComponent(t.turnId)}/result`, body);
            log.push({ turnId: t.turnId, tool: t.tool?.name, kind: t.kind, args: t.tool?.args, posted: posted.status, at: Date.now() });
          })();
        }
        await sleep(500);
      }
    })();
    this.stopTurns = () => { on = false; return loop; };
    return { log, stop: () => this.stopTurns() };
  }
}

// ── The world ─────────────────────────────────────────────────────────────────────────────────────────────
export class World {
  static async start({ dry, ports, limitSeconds, keep = false, useProxy = false, say }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-assistant-scn-'));
    const w = new World();
    Object.assign(w, { dry, ports, limitSeconds, dir, base: `http://127.0.0.1:${ports.mw}`, people: new Map(), lanes: [], startedAt: Date.now(), provider: null, media: null, proxy: null });
    w.guard = new Guard({ dir, keep, say });
    w.clock = { t0Wall: 0, t0Perf: 0, started: false, now() { return this.started ? performance.now() - this.t0Perf : 0; } };
    if (dry) {
      w.provider = new FakeProvider({ port: ports.provider }); await w.provider.listen(); w.guard.onClose(() => w.provider.close());
      w.media = await startFakeMedia(ports.media); w.guard.onClose(() => w.media.close());
    } else if (useProxy) {
      w.proxy = new PassThroughProxy({ port: ports.proxy }); await w.proxy.listen(); w.guard.onClose(() => w.proxy.close());
    }
    w.child = startMiddleware({ dir, ports, dry, limitSeconds, useProxy, sinkBase: w.base });
    w.guard.attachChild(w.child);
    await waitHealthy(w.child, w.base);
    return w;
  }

  /** Start the scenario clock (time zero of every lane and of the fake provider's plan). */
  startClock() {
    this.clock.t0Wall = Date.now(); this.clock.t0Perf = performance.now(); this.clock.started = true;
    this.provider?.setT0(this.clock.t0Wall);
  }

  /** The cut: the provider connection destroyed, on the fake provider or (paid) on the pass-through proxy. */
  cutProvider() { if (this.provider) this.provider.cut(); else this.proxy?.cut(); }

  async person(def) {
    const p = new Person(def, this.base, this.ports.mw);
    await p.signIn(); await p.connect();
    this.people.set(def.userId, p); this.guard.onClose(async () => p.close());
    return p;
  }

  lane(person, call, opts = {}) {
    const lane = new Lane({ clock: this.clock, base: this.base, sink: call.sink, participantId: call.participantIds[person.userId], secret: this.dry ? SINK_SECRET : undefined, provider: this.provider, who: person.p, ...opts });
    this.lanes.push(lane);
    return lane;
  }

  async stopLanes() { await Promise.all(this.lanes.map((l) => l.stop())); }
  async close() { try { await this.stopLanes(); } catch { /* ending */ } await this.guard.shutdown(); }
}

// ── One call with Nova in it ──────────────────────────────────────────────────────────────────────────────
export class Call {
  /** Seat `inviter` and `others` in one call (the gateway's call verbs, as the portal sends them), join the call chat channel. */
  static async open(world, inviter, others) {
    const c = new Call(); c.world = world; c.callId = `scn-${stamp()}`; c.inviter = inviter; c.seated = [inviter]; c.participantIds = {};
    c.lobby = 'orgiq:initiative:p-observability'; // the initiative room the walk's call uses: any number of orgiq members may take a seat
    c.A = `/api/calls/${encodeURIComponent(c.callId)}/assistant`; c.chat = `orgiq:huddle:${c.callId}`; c.acked = new Set();
    if (others.length) await c.seat(others);
    for (const p of c.seated) await c.chatJoin(p);
    return c;
  }
  async seat(people) {
    const list = Array.isArray(people) ? people : [people];
    const first = this.seated.length === 1 && this.seated[0] === this.inviter && !this.invitedOnce;
    this.inviter.send({ service: 'call', action: 'invite', callId: this.callId, lobbyName: this.lobby, callerId: this.inviter.userId, callerName: this.inviter.name, channel: this.lobby, targetUserIds: list.map((p) => p.userId) });
    this.invitedOnce = true;
    for (const p of list) {
      await p.waitFrame((f) => f.type === 'call' && f.action === 'invite', 15_000).catch(() => { throw new Error(`${p.name} was never rung (no invite frame); frames seen: ${p.frames.map((f) => `${f.type}/${f.action ?? ''}`).slice(-6).join(' ')}`); });
      p.send({ service: 'call', action: 'accepted', callId: this.callId, lobbyName: this.lobby, callerId: p.userId, userId: p.userId, targetUserIds: [this.inviter.userId] });
      this.seated.push(p);
    }
    for (const p of this.seated) {
      this.participantIds[p.userId] ??= `${p.userId}-${stamp()}`;
      p.send({ service: 'call', action: 'participant-state', callId: this.callId, lobbyName: this.lobby, callerId: p.userId, userId: p.userId, participantId: this.participantIds[p.userId],
        audioOn: true, cameraOn: false, screenSharing: false, targetUserIds: this.seated.filter((q) => q !== p).map((q) => q.userId) });
    }
    await this.inviter.waitFrame((f) => f.type === 'call-chat' && f.action === 'members' && f.participants?.length === this.seated.length, 20_000).catch(() => { throw new Error(`the call did not reach ${this.seated.length} seats; ${this.inviter.name} saw ${this.inviter.frames.map((f) => `${f.type}/${f.action ?? ''}/${f.participants?.length ?? ''}`).slice(-8).join(' ')}`); });
    void first;
  }
  async chatJoin(p) {
    p.send({ service: 'chat', action: 'join', channel: this.chat });
    await p.waitFrame((f) => f.type === 'chat' && f.action === 'joined' && f.channel === this.chat, 15_000).catch(() => { throw new Error(`${p.name} could not join ${this.chat}; saw ${p.frames.map((f) => `${f.type}/${f.action ?? ''}/${String(f.message ?? f.error ?? '').slice(0, 50)}`).slice(-6).join(' ')}`); });
  }
  async inviteNova() {
    const r = await this.inviter.call('POST', `${this.A}/invite`, {});
    if (r.status !== 201) throw new Error(`the invite was refused: HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`);
    this.invitedAt = Date.now();
    this.world.guard.onDismiss(async () => { const d = await this.inviter.call('POST', `${this.A}/dismiss`); return { status: d.status, state: d.json?.state }; });
    return r;
  }
  async bind(p) { return p.call('POST', `${this.A}/participant`, { participantId: this.participantIds[p.userId] }); }
  async ack(p) { this.acked.add(p.userId); return p.call('POST', `${this.A}/ack`); }
  /** Where the taps would post, from the mock world's dev route. */
  async discoverSink() {
    let sink = null;
    for (let i = 0; i < 40 && !sink?.token; i += 1) { sink = (await this.inviter.call('GET', `/api/dev/calls/${encodeURIComponent(this.callId)}/assistant-audio`)).json; await sleep(150); }
    if (!sink?.token) throw new Error('no sink token');
    this.sink = sink; return sink;
  }
  state(p = this.inviter) { return p.call('GET', `${this.A}/state`).then((r) => r.json); }
  audio() { return this.inviter.call('GET', `/api/dev/calls/${encodeURIComponent(this.callId)}/assistant-audio`).then((r) => r.json); }
  async transcript() { return (await this.inviter.call('GET', `${this.A}/transcript?limit=500`)).json?.lines ?? []; }
  async chatMessages(p = this.inviter) { return (await p.call('GET', `/api/calls/${encodeURIComponent(this.callId)}/chat?limit=100`)).json?.messages ?? []; }
  /** Nova's messages in the call chat (replies, cards, notices). */
  async novaMessages(p = this.inviter) { return (await this.chatMessages(p)).filter((m) => m.metadata?.assistant === true); }
  async dismiss() { const r = await this.inviter.call('POST', `${this.A}/dismiss`); this.world.guard.onDismiss(null); return r; }

  /**
   * The ordinary start of a call: seat everyone, invite Nova, bind every participant id, acknowledge everyone named in `ack`
   * (default: everybody but the inviter), optionally turn the voice on, find the sink and arm the scenario clock.
   */
  static async start(world, { inviter, others = [], ack = others, voice = false }) {
    const c = await Call.open(world, inviter, others);
    await c.inviteNova();
    for (const p of c.seated) await c.bind(p);
    for (const p of ack) await c.ack(p);
    if (voice) await inviter.call('POST', `${c.A}/voice`, { on: true });
    await c.discoverSink();
    return c;
  }
}

/** Billed seconds and the ledger entry for a finished call, as live-e2e reads them. */
export async function billingOf(person, call) {
  const state = await call.state(person);
  let ledger = null;
  for (let i = 0; i < 12 && !ledger; i += 1) {
    const entries = (await person.call('GET', '/api/spend/entries?groupBy=source&key=meeting_assistant&period=month&limit=50')).json?.entries ?? [];
    const mine = entries.filter((e) => String(e.sourceId ?? '').startsWith(`ma:${call.callId}`) && !String(e.sourceId).endsWith(':minutes'));
    if (mine.length) ledger = mine.map((e) => ({ sourceId: e.sourceId, seconds: e.seconds ?? e.quantity, costUsd: e.costUsd ?? e.amountUsd ?? e.usd, basis: e.basis }));
    else await sleep(400);
  }
  // A ledger entry carries its cost (and sometimes its seconds): the seconds are what the cost buys at the provider's rate.
  const ledgerSeconds = ledger ? Math.round(ledger.reduce((n, e) => n + (Number(e.seconds) || (Number(e.costUsd) || 0) / PRICE_PER_MINUTE * 60), 0)) : null;
  return { listeningSeconds: state?.listeningSeconds, ledger, ledgerSeconds, state };
}
