// Nova's voice in the browser: a thin WebAudio player over lib/novaVoiceModel.ts.
// Frames come from the call-chat socket the page already has (`assistant-audio`); each is decoded and scheduled
// on one AudioContext. The audio is only played: never recorded, stored, logged or re-sent. The only thing kept
// across visits is the person's mute choice. Where no AudioContext can be made, frames are still counted as
// "would schedule" on a plain clock so the mark and the walk behave the same.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useGatewayFrames } from './gatewayFrames';
import type { AssistantView } from './meetingAssistantModel';
import { SPEAKING_HOLD_MS, parseAudioFrame, pcm16ToFloat32, scheduleFrame, shouldPlay, type AudioFrame } from './novaVoiceModel';

const MUTE_KEY = 'orgiq.novaMuted';

export interface NovaVoiceSnapshot {
  muted: boolean;
  /** Frames are arriving now (back to false SPEAKING_HOLD_MS after the last one). */
  speaking: boolean;
  /** Frames arrived but the browser has not allowed sound yet (no click on the page). */
  needsGesture: boolean;
  framesPlayed: number;
  framesIgnored: number;
  lastSeq: number;
}

interface Clock { currentTime: number; state?: string }

const readMuted = (): boolean => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } };

class NovaPlayer {
  private ctx: AudioContext | null = null;
  private clock: Clock = { get currentTime() { return performance.now() / 1000; } };
  private nextStart = 0;
  private utterance = false;
  private sources = new Set<AudioBufferSourceNode>();
  private hold: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private snap: NovaVoiceSnapshot = { muted: readMuted(), speaking: false, needsGesture: false, framesPlayed: 0, framesIgnored: 0, lastSeq: 0 };

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => this.snap;
  private set(patch: Partial<NovaVoiceSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  setMuted(muted: boolean) {
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* private window: the choice lasts this visit only */ }
    if (muted) this.stop();
    this.set({ muted });
  }

  /** The browser only lets sound start after a click; this is that click. */
  async resume() {
    try { await this.ctx?.resume(); } catch { /* still suspended */ }
    this.set({ needsGesture: this.ctx?.state === 'suspended' });
  }

  ignored() { this.set({ framesIgnored: this.snap.framesIgnored + 1 }); }

  private context(): Clock {
    if (!this.ctx && typeof AudioContext !== 'undefined') {
      try { this.ctx = new AudioContext({ sampleRate: 24000 }); } catch { try { this.ctx = new AudioContext(); } catch { this.ctx = null; } }
    }
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    return this.ctx ?? this.clock;
  }

  play(frame: AudioFrame) {
    const samples = pcm16ToFloat32(frame.pcm);
    const clock = this.context();
    const seconds = samples.length / frame.sampleRate;
    const d = scheduleFrame({ currentTime: clock.currentTime, nextStartTime: this.nextStart, frameSeconds: seconds, utteranceStarted: this.utterance, running: this.ctx ? this.ctx.state === 'running' : true });
    if (!d.play) { this.utterance = false; this.set({ framesIgnored: this.snap.framesIgnored + 1, lastSeq: frame.seq, needsGesture: this.ctx?.state === 'suspended' }); return; }
    this.utterance = !frame.last;
    this.nextStart = d.nextStartTime;
    if (this.ctx && samples.length > 0) {
      const buffer = this.ctx.createBuffer(1, samples.length, frame.sampleRate);
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const src = this.ctx.createBufferSource();
      src.buffer = buffer; src.connect(this.ctx.destination);
      src.onended = () => { this.sources.delete(src); };
      this.sources.add(src);
      src.start(d.startAt);
    }
    if (this.hold) clearTimeout(this.hold);
    this.hold = setTimeout(() => { this.hold = null; this.set({ speaking: false }); }, SPEAKING_HOLD_MS);
    this.set({ speaking: true, framesPlayed: this.snap.framesPlayed + 1, lastSeq: frame.seq, needsGesture: this.ctx?.state === 'suspended' });
  }

  /** At once: cancel what is scheduled, forget the utterance. */
  stop() {
    for (const s of this.sources) { try { s.onended = null; s.stop(); } catch { /* already ended */ } }
    this.sources.clear();
    this.utterance = false; this.nextStart = 0;
    if (this.hold) { clearTimeout(this.hold); this.hold = null; }
    if (this.snap.speaking || this.snap.needsGesture) this.set({ speaking: false, needsGesture: false });
  }

  /** A new call starts counting from nothing; the server's `seq` is per call. */
  resetCall() { this.stop(); this.set({ framesPlayed: 0, framesIgnored: 0, lastSeq: 0 }); }
}

const player = new NovaPlayer();

/**
 * Plays Nova's voice for one call while the state says it should. Every hook runs before any return.
 * Returns the player's snapshot and the controls the Nova mark's menu uses.
 */
export function useNovaVoice(callId: string | null, view: AssistantView) {
  const { gateway } = useGatewayFrames();
  const snap = useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);
  const live = useRef({ callId, voice: view.voice, listening: view.phase === 'listening' || view.phase === 'invited', muted: snap.muted });
  live.current = { callId, voice: view.voice, listening: view.phase === 'listening' || view.phase === 'invited', muted: snap.muted };
  const shouldSound = !!callId && view.voice && live.current.listening && !snap.muted;

  useEffect(() => {
    if (!callId) return undefined;
    player.resetCall();
    return gateway.onMessage((raw) => {
      const frame = parseAudioFrame(raw);
      if (!frame) return;
      const cur = live.current;
      if (frame.callId !== cur.callId) return;
      if (shouldPlay({ callId: cur.callId ?? '', frameCallId: frame.callId, seq: frame.seq, lastSeq: player.getSnapshot().lastSeq, muted: cur.muted, voice: cur.voice, listening: cur.listening })) player.play(frame);
      else if (frame.seq > player.getSnapshot().lastSeq) player.ignored();
    });
  }, [callId, gateway.onMessage]);

  // Pause, leave, voice off, mute, call end: nothing more is played and what is scheduled is cancelled.
  useEffect(() => { if (!shouldSound) player.stop(); }, [shouldSound]);
  useEffect(() => () => player.stop(), []);

  return {
    ...snap,
    setMuted: (m: boolean) => player.setMuted(m),
    enableSound: () => player.resume(),
  };
}
