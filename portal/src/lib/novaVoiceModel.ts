// Nova's spoken replies as the browser plays them (docs/meeting-assistant-design.md, decision 4, package 7).
// Pure: the frame reader, the sequence filter and the scheduling decision. The AudioContext wiring is lib/novaVoice.ts.
// Audio is only decoded and played; nothing here stores, logs or sends it.

export const NOVA_SAMPLE_RATE = 24000;
/** Buffered ahead at the start of an utterance so a late frame does not leave a gap. */
export const JITTER_BUFFER_S = 0.15;
/** Smallest distance after `currentTime` a frame is scheduled at. */
export const SCHEDULE_LEAD_S = 0.02;
/** A frame that would start this far behind the clock is dropped rather than played late. */
export const MAX_LATE_S = 0.5;
/** The mark goes back to "listening" this long after the last frame. */
export const SPEAKING_HOLD_MS = 400;

export interface AudioFrame { callId: string; seq: number; sampleRate: number; pcm: string; last: boolean }

/** Reads one gateway frame; null unless it is an `assistant-audio` frame with a well-formed body. */
export function parseAudioFrame(frame: unknown): AudioFrame | null {
  if (!frame || typeof frame !== 'object') return null;
  const f = frame as Record<string, unknown>;
  if (f['type'] !== 'assistant-audio') return null;
  const d = f['data'];
  if (!d || typeof d !== 'object') return null;
  const b = d as Record<string, unknown>;
  const { callId, seq, sampleRate, pcm } = b;
  if (typeof callId !== 'string' || !callId || typeof pcm !== 'string') return null;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return null;
  const rate = typeof sampleRate === 'number' && sampleRate >= 8000 && sampleRate <= 96000 ? sampleRate : NOVA_SAMPLE_RATE;
  return { callId, seq, sampleRate: rate, pcm, last: b['last'] === true };
}

/** Base64 PCM16 mono little-endian to floats in [-1, 1). An odd trailing byte is ignored. */
export function pcm16ToFloat32(base64: string): Float32Array {
  let bin: string;
  try { bin = atob(base64); } catch { return new Float32Array(0); }
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 0x8000;
  }
  return out;
}

export interface PlayGate { callId: string; frameCallId: string; seq: number; lastSeq: number; muted: boolean; voice: boolean; listening: boolean }
/** Whether a frame may be played: this call, newer than the last one, not muted, voice on and Nova listening. */
export function shouldPlay(g: PlayGate): boolean {
  return g.frameCallId === g.callId && g.seq > g.lastSeq && !g.muted && g.voice && g.listening;
}

export interface ScheduleInput {
  currentTime: number; nextStartTime: number; frameSeconds: number; utteranceStarted: boolean;
  /** Whether the audio context is running; a suspended one plays nothing, and a frame is dropped rather than queued behind it. Default true. */
  running?: boolean;
}
export type ScheduleDecision = { play: true; startAt: number; nextStartTime: number } | { play: false };

/**
 * When a frame starts. The first of an utterance waits for the jitter buffer; later ones follow the previous end so the
 * speech is gapless. A frame that would start more than MAX_LATE_S behind the clock begins a new utterance (the jitter
 * buffer again) instead of being dropped with the rest of its speech. While the context is not running a frame is dropped.
 */
export function scheduleFrame(i: ScheduleInput): ScheduleDecision {
  if (i.running === false) return { play: false };
  const floor = i.currentTime + SCHEDULE_LEAD_S;
  const late = i.utteranceStarted && i.currentTime - i.nextStartTime > MAX_LATE_S;
  const wanted = i.utteranceStarted && !late ? i.nextStartTime : i.currentTime + JITTER_BUFFER_S;
  const startAt = Math.max(wanted, floor);
  return { play: true, startAt, nextStartTime: startAt + i.frameSeconds };
}
