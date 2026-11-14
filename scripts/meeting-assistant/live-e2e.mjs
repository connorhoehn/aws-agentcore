#!/usr/bin/env node
// The meeting assistant with real audio, end to end (docs/meeting-assistant-design.md, "Running it against real media").
//
//   node scripts/meeting-assistant/live-e2e.mjs --dry          NO PROVIDER, NO COST. The same flow against a fake provider WebSocket
//                                                              (and a fake media server that is armed and disarmed) on local ports.
//   node scripts/meeting-assistant/live-e2e.mjs --yes          THE PAID CHECK. One real live session of about 45 seconds (about $0.04
//                                                              at the provider's $0.05 per minute, plus a few cents of tool-call tokens).
//                                                              Without --yes it prints this and stops.
//
// What it does. It starts its OWN middleware on port 3953 in the mock world with the meeting assistant on and MEETING_ASSISTANT_LIVE=1
// (the mock world uses the provider's real session class; in --dry it is pointed at the fake provider with a dummy key, so the real key
// is never read). It seats two demo personas in one call over the in-process gateway, binds their media participant ids, invites Nova,
// and plays the part of the media server's taps (tap-sim.mjs) with synthetic speech made by macOS `say` in two voices:
//   chatter with no name, "Nova, what is two plus two?", more chatter including the name without a request, then
//   "Nova, create a work item for the login cookie bug."
// and asserts: each utterance stored with the right speaker; no reply during chatter; a reply to the first request in the call chat
// labelled with the right asker; an action card waiting for the right asker for the second; refusedCalls 0. Then it dismisses and
// prints the billed seconds.
//
// Nova's voice (package 7a). The fake provider sends one SILENT output frame (100 ms, all zero) for every input frame, as the real one does,
// and voiced frames (a sine) for each spoken reply. Both people join the call chat channel with their gateway sockets, which is how the
// browser will receive `assistant-audio` frames. In --dry the gateway runs in the script's own middleware process, so the script acts as
// the members' sockets (no dev read is needed) and asserts: with the voice off (the default) the first spoken reply relays NOTHING; the
// voice is then turned on over the route and the second spoken reply arrives at both sockets as voiced frames in order, with a `last`
// frame, and nothing for the silence. In the paid run the voice is turned on at the start and the number of relayed frames is printed.
//
// Safety. The session is hard-stopped 75 seconds after the invite whatever happens, and the script always dismisses (and then stops
// its own middleware by PID). Audio is read from files it makes in a temp folder, is posted to its own middleware, and is never
// written by the server. Nothing here prints a key or a token. Ports: 3953 (middleware), 3954 (fake provider), 3955 (fake media).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runTapSim, readWav } from './tap-sim.mjs';
import {
  Guard, installSafetyHandlers, parseBudget, worstCaseUsd, portsFor, startMiddleware, waitHealthy, tailLog as tailLogOf, startFakeMedia, Person, speakToFile, stamp, sleep,
} from './lib/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MW = path.join(ROOT, 'middleware');
const { WebSocketServer } = createRequire(path.join(MW, 'package.json'))('ws');

const args = process.argv.slice(2);
const flagOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const DRY = args.includes('--dry');
const YES = args.includes('--yes');
const KEEP = args.includes('--keep-logs');
let BUDGET;
try { BUDGET = parseBudget(flagOf('--budget-usd')); } catch (e) { console.error(`live-e2e: ${e.message}`); process.exit(2); }
const PORTS = portsFor(flagOf('--port-base') !== undefined ? Number(flagOf('--port-base')) : 3953);
const PORT = PORTS.mw, PROVIDER_PORT = PORTS.provider, MEDIA_PORT = PORTS.media;
const BASE = `http://127.0.0.1:${PORT}`;
const HARD_STOP_MS = 75_000;
const LIMIT_SECONDS = HARD_STOP_MS / 1000; // the server's own ceiling is this plus a minute; the dead-man preload ends the process after it too
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-assistant-e2e-'));
const guard = new Guard({ dir: OUT, keep: KEEP });
installSafetyHandlers(() => guard);

if (!DRY && !YES) {
  console.log('live-e2e: this is the PAID check: one real live session of about 45 seconds, about $0.04 of voice time (the provider bills $0.05 a minute, per second)');
  console.log(`plus a few cents of tool-call tokens (worst case $${worstCaseUsd(LIMIT_SECONDS).toFixed(2)}). It reads the key from middleware/.env and stops itself 75 seconds after the invite.`);
  console.log('Re-run with --yes to run it, or with --dry to run the whole chain against a fake provider (no cost).');
  fs.rmSync(OUT, { recursive: true, force: true });
  process.exit(2);
}
if (!DRY && worstCaseUsd(LIMIT_SECONDS) > BUDGET) { console.error(`live-e2e: the worst case $${worstCaseUsd(LIMIT_SECONDS).toFixed(2)} passes --budget-usd ${BUDGET}; nothing was started`); fs.rmSync(OUT, { recursive: true, force: true }); process.exit(2); }

if (!DRY) {
  // The key is read by the middleware itself from middleware/.env (as the voice navigator's is); check it is there without reading it out.
  let present = false;
  try { present = /^OPENAI_API_KEY=\S/m.test(fs.readFileSync(path.join(MW, '.env'), 'utf8')) && !/^OPENAI_API_KEY=.*REPLACE_ME/m.test(fs.readFileSync(path.join(MW, '.env'), 'utf8')); } catch { present = false; }
  if (!present) { console.error('live-e2e: middleware/.env has no OPENAI_API_KEY; nothing was started and nothing was spent'); fs.rmSync(OUT, { recursive: true, force: true }); process.exit(2); }
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); return !!ok; };

// ── Personas ──────────────────────────────────────────────────────────────────────────────────────────
const VERA = { userId: 'u-vera', role: 'org-leader', voice: 'Samantha', name: 'Vera' };
const SINK_SECRET = 'dry-sink-secret'; // the dry run's second credential on the sink (what the real media server's LIVE_CAPTIONS_SHARED_SECRET is)
const NORA = { userId: 'u-nora', role: 'sme', voice: 'Daniel', name: 'Nora' };
const LOBBY = 'orgiq:dm:u-nora:u-vera';
const pid = (p) => `${p.userId}-${stamp()}`; // the media server's per-join id: `${userId}-${Date.now().toString(36)}`

/** What is said, by whom, and the pause after it. `keyword` finds it again in the stored transcript. */
const SCRIPT = [
  { who: VERA, text: 'Okay, I went through the dashboard this morning, and the numbers look fairly steady.', keyword: /dashboard|numbers look/i, gap: 1800 },
  { who: NORA, text: 'Right, but the login page still feels slow for a few people.', keyword: /login page|feels slow|slow for a few/i, gap: 2500 },
  { who: VERA, text: 'Nova, what is two plus two?', keyword: /two plus two|2 ?(\+|plus) ?2/i, gap: 8000, request: 'answer' },
  { who: NORA, text: 'I think Nova could help with that later, but lets move on to the roadmap.', keyword: /help with that later|move on to the roadmap/i, gap: 3000 },
  { who: VERA, text: 'Agreed, we should plan the roadmap review for next week.', keyword: /review for next week|plan the roadmap review/i, gap: 2500 },
  { who: NORA, text: 'Nova, create a work item for the login cookie bug.', keyword: /cookie bug|work item for the login/i, gap: 0, request: 'tool' },
];

// ── A fake provider (dry run): replays a canned session, driven by the audio it is sent ──────────────────
function startFakeProvider(script) {
  const seen = { frames: 0, bytes: 0, badFrames: 0, started: 0, closed: 0, toolResults: 0, wallStart: 0, wallLast: 0, voicedSent: 0, silentSent: 0, replies: [] };
  const wss = new WebSocketServer({ port: PROVIDER_PORT, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    let audioMs = 0, voiced = null, quiet = 0, utterance = 0, openedAt = Date.now(), speaking = 0, outSeq = 0;
    // One output frame for every input frame (measured on the real provider): all zero unless the model is speaking, then a sine.
    const silent = Buffer.alloc(4800).toString('base64');
    const tone = Buffer.alloc(4800); for (let i = 0; i < 2400; i += 1) tone.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 330 * i) / 24000)), i * 2);
    const voicedB64 = tone.toString('base64');
    const speak = (label) => { speaking += 6; seen.replies.push(label); };
    const send = (ev) => { try { ws.send(JSON.stringify(ev)); } catch { /* closed */ } };
    const finishRun = (run) => {
      const item = script[utterance]; utterance += 1;
      if (!item) return;
      send({ type: 'session.input_transcript.delta', start_ms: run.start, end_ms: run.end, delta: ` ${item.text}` });
      if (item.request === 'answer') {
        setTimeout(() => {
          send({ type: 'session.output_transcript.delta', start_ms: audioMs, end_ms: audioMs + 200, delta: ' Two plus two is four.' });
          speak('answer');
        }, 150);
      } else if (item.request === 'tool') {
        send({ type: 'session.delegation.created', offset_ms: audioMs, delegation: { id: 'item_dry_1', type: 'delegation', target: 'responses' } });
        send({ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_dry_1', name: 'create',
          arguments: JSON.stringify({ kind: 'work-item', fields: { title: 'Login cookie bug' } }) } } });
      }
    };
    ws.on('message', (data) => {
      let ev; try { ev = JSON.parse(String(data)); } catch { return; }
      if (ev.type === 'session.start') {
        seen.started += 1; openedAt = Date.now();
        send({ type: 'session.started', client_event_id: ev.event_id, session: { id: 'live_dry_1', status: 'active' } });
      } else if (ev.type === 'session.input_audio.append') {
        const buf = Buffer.from(String(ev.audio ?? ''), 'base64');
        if (buf.length !== 4800) seen.badFrames += 1;
        seen.frames += 1; seen.bytes += buf.length; if (!seen.wallStart) seen.wallStart = Date.now(); seen.wallLast = Date.now();
        outSeq += 1;
        if (speaking > 0) { speaking -= 1; seen.voicedSent += 1; send({ type: 'session.output_audio.delta', delta: voicedB64, event_id: `out_${outSeq}` }); }
        else { seen.silentSent += 1; send({ type: 'session.output_audio.delta', delta: silent, event_id: `out_${outSeq}` }); }
        let sum = 0; const n = buf.length / 2; for (let i = 0; i < n; i += 1) { const v = buf.readInt16LE(i * 2); sum += v * v; }
        const loud = Math.sqrt(sum / Math.max(1, n)) > 350;
        const t0 = audioMs; audioMs += (buf.length / 2 / 24000) * 1000;
        if (loud) { quiet = 0; voiced = voiced ? { ...voiced, end: audioMs } : { start: t0, end: audioMs }; }
        else { quiet += (n / 24000) * 1000; if (voiced && quiet >= 900) { const run = voiced; voiced = null; finishRun(run); } }
      } else if (ev.type === 'response.item.create') {
        seen.toolResults += 1;
        send({ type: 'session.output_transcript.delta', start_ms: audioMs, end_ms: audioMs + 200, delta: ' I have asked Nora to confirm that.' });
        speak('confirm');
      } else if (ev.type === 'session.close') {
        seen.closed += 1;
        send({ type: 'session.closed', reason: 'closed', usage: { seconds: Math.round((Date.now() - openedAt) / 1000) } });
      }
    });
  });
  return { seen, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }) };
}

async function main() {
  console.log(`live-e2e: ${DRY ? 'DRY RUN (fake provider, no cost)' : 'PAID RUN (real provider session)'}; working folder ${OUT}`);
  // 1. Speech, and the timeline the taps will play.
  const timeline = []; let at = 500; const spans = [];
  for (const [i, item] of SCRIPT.entries()) {
    const file = path.join(OUT, `u${i + 1}.wav`);
    const how = speakToFile(item.text, item.who.voice, file);
    const samples = readWav(file).length, ms = Math.round((samples / 16000) * 1000);
    timeline.push({ participantId: null, who: item.who, wav: path.basename(file), atMs: at });
    spans.push({ ...item, startMs: at, endMs: at + ms, how });
    at += ms + item.gap;
  }
  console.log(`speech: ${spans[0].how}; ${spans.length} utterances, ${Math.round(at / 1000)} s of call audio`);

  const provider = DRY ? startFakeProvider(SCRIPT) : null;
  const media = DRY ? await startFakeMedia(MEDIA_PORT) : null;
  if (provider) guard.onClose(() => provider.close());
  if (media) guard.onClose(() => media.close());
  const child = startMiddleware({ dir: OUT, ports: PORTS, dry: DRY, limitSeconds: LIMIT_SECONDS, sinkBase: BASE });
  guard.attachChild(child);
  const vera = new Person(VERA, BASE, PORT), nora = new Person(NORA, BASE, PORT);
  vera.keepAudioFrames = true; nora.keepAudioFrames = true;
  let callId = null, invited = false, watchdog = null, providerErrors = null;
  const hardStop = () => { console.log(`HARD STOP: ${HARD_STOP_MS / 1000} s since the invite`); void guard.shutdown().finally(() => process.exit(1)); };
  try {
    await waitHealthy(child, BASE);
    await vera.signIn(); await nora.signIn();
    await vera.connect(); await nora.connect();

    // 2. Two people in one call (the gateway's call verbs, as the portal sends them).
    callId = `e2e-${stamp()}`;
    vera.send({ service: 'call', action: 'invite', callId, lobbyName: LOBBY, callerId: VERA.userId, callerName: VERA.name, channel: LOBBY, targetUserIds: [NORA.userId] });
    await nora.waitFrame((f) => f.type === 'call' && f.action === 'invite');
    nora.send({ service: 'call', action: 'accepted', callId, lobbyName: LOBBY, callerId: NORA.userId, userId: NORA.userId, targetUserIds: [VERA.userId] });
    await vera.waitFrame((f) => f.type === 'call' && f.action === 'accepted');
    const participantIds = { [VERA.userId]: pid(VERA), [NORA.userId]: pid(NORA) };
    for (const [me, other] of [[VERA, NORA], [NORA, VERA]]) {
      (me === VERA ? vera : nora).send({ service: 'call', action: 'participant-state', callId, lobbyName: LOBBY, callerId: me.userId, userId: me.userId, participantId: participantIds[me.userId],
        audioOn: true, cameraOn: false, screenSharing: false, targetUserIds: [other.userId] });
    }
    await vera.waitFrame((f) => f.type === 'call-chat' && f.action === 'members' && f.participants?.length === 2, 20_000);
    check('two people hold seats in one call', true, callId);
    // Each person joins the call chat channel, as the browser does for the chat; Nova's voice frames go to the sockets that did.
    const CHAT = `orgiq:huddle:${callId}`;
    for (const person of [vera, nora]) {
      person.send({ service: 'chat', action: 'join', channel: CHAT });
      await person.waitFrame((f) => f.type === 'chat' && f.action === 'joined' && f.channel === CHAT, 15_000);
    }
    const voiceFrames = (person) => person.frames.filter((f) => f.type === 'assistant-audio' && f.channel === CHAT);

    // 3. Vera invites Nova; then each person binds their own participant id (the portal does this once it knows the assistant is there); Nora acknowledges.
    const A = `/api/calls/${encodeURIComponent(callId)}/assistant`;
    const invite = await vera.call('POST', `${A}/invite`, {});
    if (invite.status !== 201) { check('Vera invites Nova', false, `HTTP ${invite.status} ${JSON.stringify(invite.json)?.slice(0, 160)}`); throw new Error('the invite was refused; nothing was started'); }
    invited = true;
    guard.onDismiss(async () => { const d = await vera.call('POST', `/api/calls/${encodeURIComponent(callId)}/assistant/dismiss`); return { status: d.status, state: d.json?.state }; });
    watchdog = setTimeout(hardStop, HARD_STOP_MS); watchdog.unref?.();
    const inviteAt = Date.now();
    check('Vera invites Nova', true, 'listening');
    for (const [person, who] of [[vera, VERA], [nora, NORA]]) {
      const bound = await person.call('POST', `${A}/participant`, { participantId: participantIds[who.userId] });
      check(`${who.name} binds ${who.name}'s own participant id`, bound.status === 200, `HTTP ${bound.status}`);
    }
    const stolen = await nora.call('POST', `${A}/participant`, { participantId: participantIds[VERA.userId] });
    check('a person cannot bind another person\'s participant id', stolen.status === 403, `HTTP ${stolen.status}`);
    check('Nora acknowledges the notice', (await nora.call('POST', `${A}/ack`)).status === 200);
    check('Nova\'s voice is off by default', (await vera.call('GET', `${A}/state`)).json?.voice === false);
    if (!DRY) check('Vera turns Nova\'s voice on (paid run)', (await vera.call('POST', `${A}/voice`, { on: true })).json?.voice === true);

    // 4. Where the taps would post: the mock world's dev route says (the real media server is told by the arming).
    let sink = null;
    for (let i = 0; i < 40 && !sink?.token; i += 1) { sink = (await vera.call('GET', `/api/dev/calls/${encodeURIComponent(callId)}/assistant-audio`)).json; await sleep(150); }
    check('the sink is armed with a token and the call\'s channel', !!sink?.token && !!sink?.channelArn, `channel ${sink?.channelArn}`);
    if (!sink?.token) throw new Error('no sink token');
    if (media) {
      await sleep(300);
      const create = media.log.find((l) => l.method === 'POST');
      const url = create?.body?.destination?.url ?? '';
      check('the media server was asked for a per-participant tap that posts to the sink with a fresh token', create?.auth === true && create?.body?.destination?.perParticipant === true && create.body.destination.type === 'webhook-pcm' && url === `${BASE}/api/internal/meeting-assistant/pcm/${sink.token}`, `${create?.url ?? 'no request'}`);
    }

    // 5. The call, as the taps would carry it, while the chat is watched.
    const plan = timeline.map((t) => ({ ...t, participantId: participantIds[t.who.userId] }));
    const novaSeen = new Map(); // message id -> { elapsed, msg }
    const t0 = Date.now();
    let polling = true;
    let offCheck = null, voiceOnAt = 0;
    const poll = (async () => {
      while (polling) {
        // Dry: once the first spoken reply is in the chat and its voiced frames have gone through the provider, the voice was off for all of it.
        if (DRY && !voiceOnAt && [...novaSeen.values()].some((v) => v.msg.metadata.kind === 'assistant-reply') && provider.seen.voicedSent >= 6) {
          await sleep(800);
          offCheck = { relayed: voiceFrames(vera).length + voiceFrames(nora).length, voicedSent: provider.seen.voicedSent, state: (await vera.call('GET', `${A}/state`)).json };
          const on = await vera.call('POST', `${A}/voice`, { on: true });
          voiceOnAt = Date.now() - t0;
          check('Vera turns Nova\'s voice on after the first reply', on.status === 200 && on.json?.voice === true, `HTTP ${on.status}`);
        }
        const r = await vera.call('GET', `/api/calls/${encodeURIComponent(callId)}/chat?limit=100`);
        for (const m of r.json?.messages ?? []) if (m.metadata?.assistant === true && !novaSeen.has(m.id)) novaSeen.set(m.id, { elapsed: Date.now() - t0, msg: m });
        // Replies and cards can change (a card's status): keep the latest of each.
        for (const m of r.json?.messages ?? []) if (novaSeen.has(m.id)) novaSeen.get(m.id).msg = m;
        await sleep(500);
      }
    })();
    const sim = await runTapSim({ base: BASE, token: sink.token, channel: sink.channelArn, timeline: plan, dir: OUT, ...(DRY ? { secret: SINK_SECRET } : {}) });
    const waitUntil = Date.now() + 14_000;
    while (Date.now() < waitUntil && ![...novaSeen.values()].some((v) => v.msg.metadata.kind === 'assistant-action' && v.msg.metadata.tool?.name === 'create')) await sleep(500);
    if (DRY) { const until = Date.now() + 8000; while (Date.now() < until && voiceFrames(vera).length < 9) await sleep(200); }
    await sleep(1500);
    polling = false; await poll;
    check('the sink took every chunk', sim.failed === 0 && (sim.answers['204'] ?? 0) === sim.sent, `${sim.sent} chunks, answers ${JSON.stringify(sim.answers)}`);
    if (DRY) {
      const wrong = await runTapSim({ base: BASE, token: sink.token, channel: sink.channelArn, timeline: [{ participantId: participantIds[VERA.userId], wav: 'u1.wav', atMs: 0 }], dir: OUT, speed: 50, secret: 'not-the-secret' });
      const none = await runTapSim({ base: BASE, token: sink.token, channel: sink.channelArn, timeline: [{ participantId: participantIds[VERA.userId], wav: 'u1.wav', atMs: 0 }], dir: OUT, speed: 50, secret: '' });
      check('the sink answers 404 to a right token with a wrong or missing secret', wrong.answers['404'] === wrong.sent && none.answers['404'] === none.sent, `wrong ${JSON.stringify(wrong.answers)}, missing ${JSON.stringify(none.answers)}`);
    }

    // 6. The transcript: each utterance, with the right speaker.
    const transcript = (await vera.call('GET', `${A}/transcript?limit=200`)).json;
    const lines = transcript?.lines ?? [];
    for (const s of spans) {
      const mine = lines.filter((l) => s.keyword.test(l.text));
      const wrong = mine.filter((l) => l.userId !== s.who.userId);
      check(`${s.who.name}'s "${s.text.slice(0, 34)}..." is stored with ${s.who.name} as the speaker`, mine.length > 0 && wrong.length === 0, mine.length ? mine.map((l) => `${l.userId ?? 'nobody'}`).join(',') : 'no such line');
    }

    // 7. What Nova did.
    const nova = [...novaSeen.values()];
    const replies = nova.filter((v) => v.msg.metadata.kind === 'assistant-reply'), cards = nova.filter((v) => v.msg.metadata.kind === 'assistant-action');
    const req1 = spans.find((s) => s.request === 'answer'), req2 = spans.find((s) => s.request === 'tool');
    const chatter2 = spans[SCRIPT.findIndex((s) => /could help with that later/.test(s.text))];
    const before = nova.filter((v) => v.msg.metadata.kind !== 'assistant-notice' && v.elapsed < req1.endMs);
    check('Nova says nothing in chat during the first chatter', before.length === 0, `${before.length} message(s) before ${req1.endMs} ms`);
    const quiet = nova.filter((v) => v.msg.metadata.kind !== 'assistant-notice' && v.elapsed > chatter2.startMs + 2500 && v.elapsed < req2.startMs);
    check('Nova says nothing when its name is used without a request', quiet.length === 0, `${quiet.length} message(s) between ${chatter2.startMs + 2500} and ${req2.startMs} ms`);
    const answer = replies.find((v) => v.msg.metadata.askedBy === VERA.userId);
    check('the first request is answered in the call chat, labelled with Vera', !!answer, answer ? `"${String(answer.msg.message ?? answer.msg.text ?? '').slice(0, 60)}" asked by ${answer.msg.metadata.askedByName}` : 'no reply');
    const card = cards.find((v) => v.msg.metadata.tool?.name === 'create');
    check('the second request is an action card waiting for Nora', !!card && card.msg.metadata.askedBy === NORA.userId && card.msg.metadata.status === 'waiting', card ? `asked by ${card.msg.metadata.askedBy}, ${card.msg.metadata.status}: ${card.msg.metadata.summary}` : 'no card');
    const stranger = card ? await vera.call('POST', `${A}/actions/${encodeURIComponent(card.msg.metadata.actionId)}/decision`, { decision: 'confirm' }) : null;
    check('only Nora can decide the card (Vera is refused)', !!stranger && stranger.status === 403, `HTTP ${stranger?.status}`);
    // Nora confirms; her browser claims the turn once, and the result needs the claim (audit B6).
    if (card) {
      const confirmed = await nora.call('POST', `${A}/actions/${encodeURIComponent(card.msg.metadata.actionId)}/decision`, { decision: 'confirm' });
      check('Nora confirms the card', confirmed.status === 200, `HTTP ${confirmed.status}`);
      const mine = (await nora.call('GET', `${A}/turns?mine=1`)).json?.turns ?? [];
      const turn = mine.find((t) => t.kind === 'write');
      check('the confirmed write is listed for Nora, and only Nora', !!turn && ((await vera.call('GET', `${A}/turns?mine=1`)).json?.turns ?? []).length === 0, `${mine.length} turn(s)`);
      if (turn) {
        const t = encodeURIComponent(turn.turnId);
        const first = await nora.call('POST', `${A}/turns/${t}/claim`), second = await nora.call('POST', `${A}/turns/${t}/claim`), other = await vera.call('POST', `${A}/turns/${t}/claim`);
        check('the turn is claimed once (a second claim is 409, anyone else 404)', first.status === 200 && !!first.json?.claimId && second.status === 409 && other.status === 404, `${first.status}/${second.status}/${other.status}`);
        const noClaim = await nora.call('POST', `${A}/turns/${t}/result`, { ok: true, output: { say: 'Created.' } });
        const wrongClaim = await nora.call('POST', `${A}/turns/${t}/result`, { claimId: 'ffffffffffffffff', ok: true, output: { say: 'Created.' } });
        const posted = await nora.call('POST', `${A}/turns/${t}/result`, { claimId: first.json?.claimId, ok: true, output: { say: 'Created.' } });
        check('a result needs the claim id: none is 400, a wrong one 409, the right one 200', noClaim.status === 400 && wrongClaim.status === 409 && posted.status === 200, `${noClaim.status}/${wrongClaim.status}/${posted.status}`);
      }
    }
    const state = (await vera.call('GET', `${A}/state`)).json;
    check('no tool call was refused', state?.refusedCalls === 0, `refusedCalls ${state?.refusedCalls}`);
    const audio = (await vera.call('GET', `/api/dev/calls/${encodeURIComponent(callId)}/assistant-audio`)).json;
    check('no participant was unmapped', (audio?.counters?.unmappedChunks ?? 1) === 0, JSON.stringify(audio?.counters));
    const stateNow = (await vera.call('GET', `${A}/state`)).json;
    providerErrors = typeof stateNow?.providerErrors === 'number' ? stateNow.providerErrors : null;
    if (DRY) {
      check('the provider sent no error event', providerErrors === 0, `providerErrors ${providerErrors}`);
      check('with the voice off (the default) the first spoken reply relayed nothing, though the provider sent voiced frames',
        offCheck && offCheck.relayed === 0 && offCheck.voicedSent >= 6 && offCheck.state?.voice === false && offCheck.state?.voiceFramesRelayed === 0,
        offCheck ? `${offCheck.voicedSent} voiced frames from the provider, ${offCheck.relayed} relayed, voice ${offCheck.state?.voice}` : 'the first reply never came');
      for (const [person, who] of [[vera, VERA], [nora, NORA]]) {
        const got = voiceFrames(person);
        const seqs = got.map((f) => f.data?.seq);
        const bytes = got.map((f) => Buffer.from(String(f.data?.pcm ?? ''), 'base64'));
        const energy = bytes.map((b) => { let m = 0; for (let i = 0; i + 1 < b.length; i += 2) m = Math.max(m, Math.abs(b.readInt16LE(i))); return m; });
        check(`${who.name}'s socket received Nova's second reply: 6 voiced frames and a 300 ms tail, in order, no silence in between, the last marked`,
          got.length === 9 && seqs.every((q, i) => i === 0 || q === seqs[i - 1] + 1) && energy.slice(0, 6).every((m) => m > 100) && energy.slice(6).every((m) => m === 0)
            && got.every((f, i) => (f.data?.last === true) === (i === 8) && f.data?.callId === callId && f.data?.sampleRate === 24000) && bytes.every((b) => b.length === 4800),
          `${got.length} frames, seq ${seqs.join(',')}`);
      }
      check('the silent output frames the provider sent throughout were dropped at the source (nothing relayed for them)',
        provider.seen.silentSent > 20 && (stateNow?.voiceFramesRelayed ?? -1) === 9 && stateNow?.voiceFramesDropped === 0,
        `${provider.seen.silentSent} silent frames sent, relayed ${stateNow?.voiceFramesRelayed}, dropped ${stateNow?.voiceFramesDropped}`);
    } else {
      console.log(`voice: the middleware relayed ${stateNow?.voiceFramesRelayed ?? '?'} frame(s) of Nova's voice to the call chat (dropped ${stateNow?.voiceFramesDropped ?? '?'})`);
    }
    if (provider) {
      const s = provider.seen;
      const wallS = (s.wallLast - s.wallStart) / 1000, audioS = s.bytes / 48000;
      check('the provider heard one 100 ms frame per 100 ms of wall time, silence included', s.badFrames === 0 && Math.abs(audioS - wallS) < 1.5, `${s.frames} frames, ${audioS.toFixed(1)} s of audio in ${wallS.toFixed(1)} s`);
      check('the delegated tool call was answered to the session', s.toolResults === 1, `${s.toolResults} result(s)`);
    }

    // 8. Dismiss, and what it cost.
    clearTimeout(watchdog);
    const left = await vera.call('POST', `${A}/dismiss`); guard.onDismiss(null);
    check('Vera dismisses Nova', left.status === 200 && left.json?.state === 'left', `HTTP ${left.status}`);
    const after = (await vera.call('GET', `${A}/state`)).json;
    let ledger = '';
    for (let i = 0; i < 20 && !ledger; i += 1) {
      const entries = (await vera.call('GET', '/api/spend/entries?groupBy=source&key=meeting_assistant&period=month&limit=50')).json?.entries ?? [];
      const mine = entries.filter((e) => String(e.sourceId ?? '').startsWith(`ma:${callId}`) && !String(e.sourceId).endsWith(':minutes'));
      if (mine.length) ledger = JSON.stringify(mine.map((e) => ({ sourceId: e.sourceId, seconds: e.seconds ?? e.quantity, costUsd: e.costUsd ?? e.amountUsd ?? e.usd, basis: e.basis })));
      else await sleep(500);
    }
    console.log(`billed: listened ${after?.listeningSeconds} s of the call (session ${Math.round((Date.now() - inviteAt) / 1000)} s since the invite); ledger ${ledger || 'no entry yet'}`);
    if (media) {
      await sleep(300);
      check('the tap was deleted when Nova left', media.log.some((l) => l.method === 'DELETE' && /\/taps\/tap-dry-1$/.test(l.url)));
      const dead = await runTapSim({ base: BASE, token: sink.token, channel: sink.channelArn, timeline: [{ participantId: participantIds[VERA.userId], wav: 'u1.wav', atMs: 0 }], dir: OUT, speed: 50, secret: SINK_SECRET });
      check('the sink token is dead after Nova left', dead.answers['404'] === dead.sent, `answers ${JSON.stringify(dead.answers)}`);
    }
  } catch (e) {
    check('the run completed', false, e.message);
    console.log(tailLogOf(OUT));
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await guard.shutdown();
  }
  console.log(`provider error events this call: ${providerErrors ?? 'unknown'} (a count only; codes are kept on the session, never their text)`);
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `live-e2e: FAIL (${failed.length} of ${results.length})` : `live-e2e: PASS (${results.length} checks)`);
  return failed.length ? 1 : 0;
}

process.exit(await main());
