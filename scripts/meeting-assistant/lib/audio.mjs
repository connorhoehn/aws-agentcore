// Synthetic audio for the meeting-assistant scenarios, and the real-time lane that posts it the way a media-server tap does.
//
// Everything audible here is synthetic test speech (macOS `say`, or tones where there is no `say`) kept in a temp folder the caller
// removes on every exit path, plus noise made in memory. Call audio and Nova's voice are never written.
//
// A tap (live-video-streaming TapManager `_createPerParticipantPcmTap`) runs one ffmpeg per participant and posts every 200 ms of what
// ffmpeg writes, with no silence gate, so a live microphone posts continuously, quiet stretches included. A lane does the same from
// `start()` to `stop()`; `silence: 'skip'` posts only the chunks that hold something audible.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readWav, CHUNK_MS } from '../tap-sim.mjs';

export const RATE = 16_000;
export const CHUNK_SAMPLES = (RATE * CHUNK_MS) / 1000;
export const VOICES = { vera: 'Samantha', nora: 'Daniel', mia: 'Karen', layla: 'Moira' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const hasSay = (() => { try { execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const FALLBACK_HZ = { Samantha: 220, Daniel: 140, Karen: 300, Moira: 180 };
function toneBurst(text, voice, rate) {
  const words = text.split(/\s+/).length, ms = Math.round((words * 330 * 175) / (rate || 175)), n = Math.round((ms / 1000) * RATE);
  const hz = FALLBACK_HZ[voice] ?? 200;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.round(9000 * Math.sin((2 * Math.PI * hz * i) / RATE) * (Math.sin(Math.PI * ((i / RATE) * 3)) ** 2));
  return out;
}

/**
 * Speech for `text` in `voice` (an installed `say` voice), optionally at `rate` words a minute: 16 kHz mono Int16Array.
 * Cached by content inside `dir`. Falls back to a tone burst per word on a machine without `say`.
 */
export function synth(text, { voice = 'Samantha', rate, dir } = {}) {
  const key = crypto.createHash('sha1').update(`${voice}|${rate ?? ''}|${text}`).digest('hex').slice(0, 12);
  const wav = path.join(dir, `s-${key}.wav`);
  if (!fs.existsSync(wav)) {
    if (!hasSay) return { pcm: toneBurst(text, voice, rate), how: 'tones' };
    const aiff = wav.replace(/\.wav$/, '.aiff');
    try {
      execFileSync('say', ['-v', voice, ...(rate ? ['-r', String(rate)] : []), '-o', aiff, '--', text], { stdio: 'ignore' });
      execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav], { stdio: 'ignore' });
      fs.rmSync(aiff, { force: true });
    } catch { return { pcm: toneBurst(text, voice, rate), how: 'tones' }; }
  }
  return { pcm: readWav(wav), how: 'say' };
}

/** Speech for `text` written to `file` as a 16 kHz mono WAV (what tap-sim.mjs plays). Returns 'say' or 'tones'. */
export function speakToFile(text, voice, file, rate) {
  const { pcm, how } = synth(text, { voice, rate, dir: path.dirname(file) });
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length * 2, 40);
  const body = Buffer.alloc(pcm.length * 2); for (let i = 0; i < pcm.length; i += 1) body.writeInt16LE(pcm[i], i * 2);
  fs.writeFileSync(file, Buffer.concat([h, body]));
  return how;
}

/** A copy of `pcm` scaled by `gain` (clipped). */
export function gained(pcm, gain) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain)));
  return out;
}

export const rms = (pcm) => { let s = 0; for (let i = 0; i < pcm.length; i += 1) s += pcm[i] * pcm[i]; return Math.sqrt(s / Math.max(1, pcm.length)); };
export const peak = (pcm) => { let m = 0; for (let i = 0; i < pcm.length; i += 1) m = Math.max(m, Math.abs(pcm[i])); return m; };

/** Linear resample of 16-bit samples from one rate to another. */
export function resample(pcm, from, to) {
  if (from === to) return Int16Array.from(pcm);
  const out = new Int16Array(Math.floor((pcm.length * to) / from));
  const step = from / to;
  for (let j = 0; j < out.length; j += 1) { const x = j * step, i = Math.floor(x), f = x - i; out[j] = Math.round(pcm[i] * (1 - f) + (pcm[Math.min(i + 1, pcm.length - 1)] ?? 0) * f); }
  return out;
}

/** Base64 PCM16 little-endian (as `assistant-audio` frames carry it) to Int16Array. */
export function pcmFromBase64(b64) {
  const b = Buffer.from(String(b64 ?? ''), 'base64');
  const out = new Int16Array(Math.floor(b.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = b.readInt16LE(i * 2);
  return out;
}

/** Concatenate Int16Arrays. */
export function concat(parts) {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export const silence = (ms) => new Int16Array(Math.round((ms / 1000) * RATE));
export const msOf = (pcm) => Math.round((pcm.length / RATE) * 1000);

/** A small deterministic generator, so a noise bed is the same on every run. */
function prng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/** Noise for samples [from, from + n) of a lane: `keyboard` clicks (short decaying bursts, about 5 a second) or a `hum`. Made in memory. */
function noiseSamples(kind, level, from, n, rand) {
  const out = new Float64Array(n);
  if (kind === 'hum') {
    for (let i = 0; i < n; i += 1) out[i] = level * (Math.sin((2 * Math.PI * 120 * (from + i)) / RATE) + 0.4 * Math.sin((2 * Math.PI * 240 * (from + i)) / RATE));
  } else if (kind === 'clicks') {
    // The clicks are a function of the absolute sample position, so a chunk boundary never moves one.
    const slot = Math.floor(RATE / 5); // one candidate click per 200 ms slot, placed inside it
    for (let s = Math.floor((from - 200) / slot); s <= Math.floor((from + n) / slot); s += 1) {
      const r = prng(s * 7919 + 13); const start = s * slot + Math.floor(r() * (slot - 200)); const len = 120;
      if (r() < 0.2) continue; // not every slot clicks
      for (let k = 0; k < len; k += 1) { const i = start + k - from; if (i >= 0 && i < n) out[i] += level * (r() * 2 - 1) * Math.exp(-k / 25); }
    }
  } else if (kind === 'dither') {
    for (let i = 0; i < n; i += 1) out[i] = level * (rand() * 2 - 1);
  }
  return out;
}

/**
 * One participant's real-time lane. `clock.now()` is the scenario clock in ms; every time here is on it.
 *   lane.say(atMs, pcm, { gain, label, dry })  an utterance at atMs; `dry` is what the fake provider does with it (see fakes.mjs)
 *   lane.inject(pcm, afterMs)                  mix this buffer in from now + afterMs (echo)
 *   lane.startAt / lane.stopAt                 begin late, stop early (scenario ms)
 *   lane.noise = { kind: 'clicks'|'hum', level, fromMs?, toMs? }   a bed, optionally only inside a window
 */
export class Lane {
  constructor({ clock, base, sink, participantId, secret, provider = null, who, noise = null, startAt = 0, stopAt = Infinity, silenceMode = 'post' }) {
    Object.assign(this, { clock, base, sink, participantId, secret, provider, who, startAt, stopAt, silenceMode });
    this.noiseBeds = noise ? (Array.isArray(noise) ? noise : [noise]) : [];
    this.events = []; this.sent = 0; this.failed = 0; this.answers = {}; this.running = false; this.loop = null; this.rand = prng(participantId.length * 31 + 7);
    this.pending = new Set();
  }

  say(atMs, pcm, { gain = 1, label = '', dry = null, text = '' } = {}) {
    const data = gain === 1 ? pcm : gained(pcm, gain);
    const ev = { atMs, endMs: atMs + msOf(pcm), pcm: data, label, text, who: this.who, dry };
    this.events.push(ev);
    this.provider?.addUtterance({ ...ev, laneWho: this.who?.userId });
    return ev;
  }

  inject(pcm, afterMs) { const atMs = this.clock.now() + afterMs; const ev = { atMs, endMs: atMs + msOf(pcm), pcm, label: 'injected', injected: true }; this.events.push(ev); return ev; }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      let k = Math.ceil(this.startAt / CHUNK_MS);
      while (this.running) {
        const t = k * CHUNK_MS;
        if (t >= this.stopAt) break;
        const wait = t - this.clock.now();
        if (wait > 0) await sleep(wait);
        if (!this.running) break;
        this.postChunk(t, k * CHUNK_SAMPLES);
        k += 1;
      }
    })();
  }

  chunkAt(tMs, sampleFrom) {
    const buf = new Float64Array(CHUNK_SAMPLES);
    const from = Math.round((tMs / 1000) * RATE);
    for (const ev of this.events) {
      if (ev.endMs <= tMs || ev.atMs >= tMs + CHUNK_MS) continue;
      const offset = Math.round((ev.atMs / 1000) * RATE) - from; // where the event's first sample falls in this chunk
      for (let i = Math.max(0, offset); i < CHUNK_SAMPLES; i += 1) { const j = i - offset; if (j >= ev.pcm.length) break; buf[i] += ev.pcm[j]; }
    }
    for (const bed of this.noiseBeds) {
      if ((bed.fromMs ?? 0) > tMs + CHUNK_MS || (bed.toMs ?? Infinity) < tMs) continue;
      const nz = noiseSamples(bed.kind, bed.level, from, CHUNK_SAMPLES, this.rand);
      for (let i = 0; i < CHUNK_SAMPLES; i += 1) buf[i] += nz[i];
    }
    return buf;
  }

  postChunk(tMs, sampleFrom) {
    // Forget events that are over, so a long lane stays cheap.
    if (this.events.length > 40) this.events = this.events.filter((e) => e.endMs > tMs - 1000);
    const buf = this.chunkAt(tMs, sampleFrom);
    const body = Buffer.allocUnsafe(CHUNK_SAMPLES * 2);
    let audible = false;
    for (let i = 0; i < CHUNK_SAMPLES; i += 1) { const v = Math.max(-32768, Math.min(32767, Math.round(buf[i]))); if (Math.abs(v) > 40) audible = true; body.writeInt16LE(v, i * 2); }
    if (this.silenceMode === 'skip' && !audible) return;
    this.sent += 1;
    const p = fetch(`${this.base}/api/internal/meeting-assistant/pcm/${encodeURIComponent(this.sink.token)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream', 'X-Tap-Id': 'tap-sim', 'X-Channel-Arn': this.sink.channelArn, 'X-Participant-Id': this.participantId,
        'X-Producer-Id': `producer-${this.participantId}`, 'X-Sample-Rate': String(RATE), 'X-Encoding': 'pcm_s16le', 'X-Channels': '1',
        ...(this.secret ? { 'X-Live-Captions-Secret': this.secret } : {}),
      },
      body,
    }).then(async (res) => { await res.arrayBuffer().catch(() => undefined); this.answers[res.status] = (this.answers[res.status] ?? 0) + 1; }, () => { this.failed += 1; });
    this.pending.add(p); p.finally(() => this.pending.delete(p));
  }

  async stop() { this.running = false; await this.loop?.catch(() => undefined); await Promise.all([...this.pending]); }
}
