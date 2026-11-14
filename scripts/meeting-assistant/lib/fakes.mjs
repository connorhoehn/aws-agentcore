// The fakes the scenarios run against with --dry: a provider WebSocket scripted per scenario, a media server for the tap arming, and
// (for the one paid scenario that cuts the provider connection) a pass-through proxy to the real provider host.
import http from 'node:http';
import tls from 'node:tls';
import https from 'node:https';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const MW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'middleware');
const { WebSocketServer } = createRequire(path.join(MW, 'package.json'))('ws');

export const PROVIDER_HOST = 'api.openai.com';
/** The provider hears a quiet stretch this long before it calls a spoken line finished. */
const VAD_MS = 900;
/** Where the provider's audio clock puts a moment of the call: the mixer's playout delay (300 ms) plus the first 100 ms frame. */
export const PIPELINE_MS = 400;
/** Quietest mixed-audio level (rms) the fake provider counts as speech heard. */
const HEARD_RMS = 150;

/**
 * A provider that does exactly what the scenario says (no model, no loudness test). Each utterance the scenario places on a lane is
 * registered with the wall time it is spoken at; the provider keeps its own audio clock (100 ms per input frame, as the real one) and, once
 * an utterance's end plus a quiet stretch has passed on it, sends the transcript delta for its span, then what `dry` says:
 *
 *   dry.transcript  true (default) | false (heard nothing) | a string (a different text than was spoken)
 *   dry.reply       { text, frames }  a spoken answer: output text and that many voiced 100 ms frames, `delayMs` after (default 400)
 *   dry.call        { name, args }    a delegation and a function call; the output comes back as `response.item.create`
 *   dry.followup    string | (output) => { text, frames }  what is said once the call's output arrives
 *   dry.id          a name other entries can point at (`echoOf`)
 * An echo entry (`addEcho`) sends a transcript delta for the window in which a reply was heard again by a microphone.
 */
export class FakeProvider {
  constructor({ port }) {
    this.port = port; this.entries = []; this.echoes = []; this.t0Wall = 0; this.connections = 0; this.live = new Set();
    this.seen = { frames: 0, bytes: 0, badFrames: 0, started: 0, closed: 0, toolResults: 0, wallStart: 0, wallLast: 0, voicedSent: 0, silentSent: 0, replies: [], calls: [], deltas: 0, cuts: 0, hangups: 0, unheard: 0 };
    this.replySpans = new Map(); // dry.id -> { startMs, endMs, text } on the connection that spoke it
    this.wss = null;
  }

  /** The scenario clock's zero, as wall time. */
  setT0(wall) { this.t0Wall = wall; }
  addUtterance(ev) { if (ev.injected) return; this.entries.push({ ...ev, done: new Set() }); }
  addEcho({ ofId, delayMs, text }) { this.echoes.push({ ofId, delayMs, text, done: new Set() }); }

  async listen() {
    // The hang-up the middleware sends over HTTP after a drop lands here too: answered and counted.
    const server = http.createServer((req, res) => { req.resume(); this.seen.hangups += 1; res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); });
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    await new Promise((r) => server.listen(this.port, '127.0.0.1', r));
    this.server = server;
  }

  /** Cut the provider connection now, as a network failure would: every live socket destroyed. */
  cut() { for (const ws of this.live) { try { ws.terminate(); } catch { /* gone */ } } this.seen.cuts += 1; }

  close() { return new Promise((r) => { for (const c of this.wss?.clients ?? []) c.terminate(); this.wss?.close(() => { this.server?.close(() => r()); }); this.server?.closeAllConnections?.(); setTimeout(r, 1500).unref?.(); }); }

  onConnection(ws) {
    this.connections += 1; this.live.add(ws);
    const st = { audioMs: 0, anchor: 0, speaking: 0, outSeq: 0, openedAt: Date.now(), calls: new Map(), callNo: 0, sentCalls: 0, rms: [] };
    const silent = Buffer.alloc(4800).toString('base64');
    const tone = Buffer.alloc(4800); for (let i = 0; i < 2400; i += 1) tone.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 330 * i) / 24000)), i * 2);
    const voiced = tone.toString('base64');
    const send = (ev) => { try { ws.send(JSON.stringify(ev)); } catch { /* closed */ } };
    const timers = new Set();
    const later = (ms, fn) => { const h = setTimeout(() => { timers.delete(h); fn(); }, ms); timers.add(h); };

    const speakText = (text, frames, id) => {
      send({ type: 'session.output_transcript.delta', start_ms: st.audioMs, end_ms: st.audioMs + frames * 100, delta: ` ${text}` });
      if (id) this.replySpans.set(id, { startMs: st.audioMs, endMs: st.audioMs + frames * 100, text, conn: this.connections });
      st.speaking += frames; this.seen.replies.push(text.slice(0, 40));
    };
    const pending = () => {
      const now = st.audioMs;
      // Utterances: heard once their span plus the quiet stretch has gone by on this connection's clock.
      const ripe = this.entries.filter((e) => !e.done.has(ws) && e.dry?.transcript !== false);
      const due = ripe.map((e) => ({ e, start: e.atMs + this.t0Wall - st.anchor + PIPELINE_MS, end: e.endMs + this.t0Wall - st.anchor + PIPELINE_MS })).filter((x) => x.end + VAD_MS <= now).sort((a, b) => a.end - b.end);
      for (const { e, start, end } of due) {
        e.done.add(ws);
        if (end < 0) continue; // spoken before this connection began
        // The provider only transcribes what it hears: nothing audible in its own audio over this span (the line was dropped before the
        // mix: not acknowledged, paused, muted) and nothing is sent.
        const from = Math.max(0, Math.floor(start / 100)), to = Math.ceil(end / 100);
        if (Math.max(0, ...st.rms.slice(from, to + 1)) < HEARD_RMS) { this.seen.unheard += 1; continue; }
        const dry = e.dry ?? {};
        const delta = typeof dry.transcript === 'string' ? dry.transcript : e.text;
        if (!delta) continue;
        send({ type: 'session.input_transcript.delta', start_ms: Math.max(0, Math.round(start)), end_ms: Math.max(1, Math.round(end)), delta: ` ${delta}` }); this.seen.deltas += 1;
        if (dry.reply) later(dry.delayMs ?? 400, () => speakText(dry.reply.text, dry.reply.frames ?? 25, dry.id));
        if (dry.call) later(dry.delayMs ?? 400, () => {
          st.callNo += 1; const callId = `call_dry_${this.connections}_${st.callNo}`; st.calls.set(callId, e); this.seen.calls.push(dry.call.name);
          send({ type: 'session.delegation.created', offset_ms: st.audioMs, delegation: { id: `item_${callId}`, type: 'delegation', target: 'responses' } });
          send({ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: callId, name: dry.call.name, arguments: JSON.stringify(dry.call.args ?? {}) } } });
        });
      }
      // Entries with transcript: false are still "heard": nothing is sent for them, they only need to leave the list.
      for (const e of this.entries) if (e.dry?.transcript === false) e.done.add(ws);
      // Echoes: the reply heard again, `delayMs` later than it was spoken.
      for (const ec of this.echoes) {
        if (ec.done.has(ws)) continue;
        const span = this.replySpans.get(ec.ofId);
        if (!span || span.conn !== this.connections) continue;
        const start = span.startMs + ec.delayMs, end = span.endMs + ec.delayMs;
        if (end + VAD_MS > now) continue;
        ec.done.add(ws);
        send({ type: 'session.input_transcript.delta', start_ms: Math.round(start), end_ms: Math.round(end), delta: ` ${ec.text ?? span.text}` }); this.seen.deltas += 1;
      }
    };
    const ticker = setInterval(pending, 50); ticker.unref?.();

    ws.on('message', (data) => {
      let ev; try { ev = JSON.parse(String(data)); } catch { return; }
      if (ev.type === 'session.start') {
        this.seen.started += 1; st.openedAt = Date.now();
        send({ type: 'session.started', client_event_id: ev.event_id, session: { id: `live_dry_${this.connections}`, status: 'active' } });
      } else if (ev.type === 'session.input_audio.append') {
        const buf = Buffer.from(String(ev.audio ?? ''), 'base64');
        if (buf.length !== 4800) this.seen.badFrames += 1;
        this.seen.frames += 1; this.seen.bytes += buf.length; if (!this.seen.wallStart) this.seen.wallStart = Date.now(); this.seen.wallLast = Date.now();
        if (!st.anchor) st.anchor = Date.now();
        st.outSeq += 1;
        if (st.speaking > 0) { st.speaking -= 1; this.seen.voicedSent += 1; send({ type: 'session.output_audio.delta', delta: voiced, event_id: `out_${st.outSeq}` }); }
        else { this.seen.silentSent += 1; send({ type: 'session.output_audio.delta', delta: silent, event_id: `out_${st.outSeq}` }); }
        { let sum = 0; const n = buf.length / 2; for (let i = 0; i < n; i += 1) { const v = buf.readInt16LE(i * 2); sum += v * v; } st.rms.push(Math.sqrt(sum / Math.max(1, n))); }
        st.audioMs += (buf.length / 2 / 24000) * 1000;
      } else if (ev.type === 'response.item.create') {
        this.seen.toolResults += 1;
        const out = String(ev.item?.output ?? '');
        const entry = st.calls.get(ev.item?.call_id);
        const f = entry?.dry?.followup;
        const r = typeof f === 'function' ? f(out) : typeof f === 'string' ? { text: f, frames: 25 } : null;
        if (r) later(300, () => speakText(r.text, r.frames ?? 25, entry.dry.id ? `${entry.dry.id}:followup` : undefined));
      } else if (ev.type === 'session.close') {
        this.seen.closed += 1;
        send({ type: 'session.closed', reason: 'closed', usage: { seconds: Math.round((Date.now() - st.openedAt) / 1000) } });
      }
    });
    ws.on('close', () => { this.live.delete(ws); clearInterval(ticker); for (const h of timers) clearTimeout(h); });
  }
}

/** The media server's tap API, as the arming talks to it. */
export function startFakeMedia(port) {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
      log.push({ method: req.method, url: req.url, auth: req.headers.authorization === 'Bearer dry-admin-token', body });
      if (req.headers.authorization !== 'Bearer dry-admin-token') { res.writeHead(401).end(); return; }
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end('[]'); return; }
      if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ tapId: 'tap-dry-1' }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ log, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) })));
}

/**
 * A loopback pass-through to the real provider host over TLS, for the one paid scenario that cuts the provider connection mid-call.
 * HTTP requests and WebSocket upgrades are forwarded with every header untouched except `host`; nothing is logged or stored, not a
 * header and not a body. `cut()` destroys both ends of every tunnel.
 */
export class PassThroughProxy {
  constructor({ port, targetHost = PROVIDER_HOST }) { this.port = port; this.targetHost = targetHost; this.pairs = new Set(); this.cuts = 0; this.opened = 0; }

  async listen() {
    const server = http.createServer((req, res) => {
      const up = https.request({ host: this.targetHost, port: 443, method: req.method, path: req.url, headers: { ...req.headers, host: this.targetHost } }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res);
      });
      up.on('error', () => { try { res.writeHead(502).end(); } catch { /* gone */ } });
      req.pipe(up);
    });
    server.on('upgrade', (req, client, head) => {
      const upstream = tls.connect({ host: this.targetHost, port: 443, servername: this.targetHost });
      const pair = [client, upstream]; this.pairs.add(pair); this.opened += 1;
      const drop = () => { for (const s of pair) { try { s.destroy(); } catch { /* gone */ } } this.pairs.delete(pair); };
      client.on('error', drop); upstream.on('error', drop); client.on('close', drop); upstream.on('close', drop);
      upstream.once('secureConnect', () => {
        // The request head, rebuilt from what arrived: the same method, path and headers, only `host` names the real server.
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i]?.toLowerCase() === 'host' ? this.targetHost : req.rawHeaders[i + 1]}`);
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
    });
    this.server = server;
    await new Promise((r) => server.listen(this.port, '127.0.0.1', r));
  }

  /** Destroy both sockets of every open tunnel. */
  cut() { for (const pair of [...this.pairs]) for (const s of pair) { try { s.destroy(); } catch { /* gone */ } } this.pairs.clear(); this.cuts += 1; }
  close() { return new Promise((r) => { this.cut(); this.server?.closeAllConnections?.(); this.server?.close(() => r()); setTimeout(r, 1500).unref?.(); }); }
}
