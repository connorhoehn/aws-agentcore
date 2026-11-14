// The real live session: the provider's primary WebSocket (docs/voice-navigator-spec.md §1, "The Live API, as V1
// measured it"). Only the OpenAI-specific event shapes live here and in lib/voice/openai.ts; the orchestrator sees
// the LiveMeetingSession interface.
//
// Wire, as recorded in the spec (nothing here is guessed):
//   out  session.start { event_id, session }                       session = liveSocketSessionBody(...): model, instructions,
//                                                                    audio { format pcm 24000, output voice }, delegation.responses.tools
//   in   session.started { session: { id } }  |  error { code, message }
//   out  session.input_audio.append { audio: <base64 PCM16 24 kHz mono> }       no commit, no acknowledgement
//   in   session.input_transcript.delta / session.output_transcript.delta { delta, start_ms, end_ms }
//   in   session.delegation.created { offset_ms, delegation }       the voice handed the request to the backend
//   in   response.event { event: { type: 'response.output_item.done', item: { type: 'function_call', call_id, name, arguments } } }
//   out  response.item.create { event_id, item: { type: 'function_call_output', call_id, output } }, then ONE response.create { event_id }
//   in   session.usage.updated / session.closed { usage: { seconds } }          cumulative seconds
//   in   nested response.completed { response: { id, usage } }                  backend tokens, each response id once
//   out  session.thinking.append { event_id, delegation_id: null, content }     silent context
//   out  session.close                                                          then session.closed; HTTPS hangup as the fallback
//
// Transcripts arrive only as DELTAS (no "done" event is documented). Input is cut into pieces: at a sentence end, at a gap of
// more than `gapMs`, at a delegation, at close, and after `idleFlushMs` of quiet. Output is cut into UTTERANCES: one runs from its
// first delta until 900 ms pass with no output delta, or the session closes; people speaking never end or split it. Typed requests: the spec records no text-input event, so `sendText` is not supported.
//
// The key never leaves lib/voice/openai.ts; nothing here logs a transcript or a tool argument.
import {
  hangupLiveSession, liveSocketSessionBody, LIVE_SOCKET_OPEN, openLiveSocket, type LiveSocket,
} from '../voice/openai.js';
import {
  MAX_PROVIDER_ERRORS, SessionEmitter, SessionTextUnsupported, type BackendTokens, type LiveMeetingSession, type ProviderErrorInfo, type SessionStartInput,
} from './session.js';

export interface OpenAiLiveSessionOptions {
  model: string;
  /** A built-in voice name or a `voice_…` id; null = the model's default. */
  voice: string | null;
  delegationModel: string;
  startTimeoutMs?: number;
  closeTimeoutMs?: number;
  idleFlushMs?: number;
  gapMs?: number;
  /** Quiet on the output side that ends one spoken utterance (default 900 ms). */
  utteranceGapMs?: number;
  /** Timer functions, injectable so a test can move time by hand. */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  clock?: () => number;
  /** The HTTPS fallback when `session.closed` never arrives. */
  hangup?: (providerSessionId: string) => Promise<boolean>;
}

/** One output frame is at most 100 ms of PCM16 mono 24 kHz. */
export const OUTPUT_FRAME_BYTES = 4800;
/** Silence that follows the last voiced frame and is still relayed, so an utterance does not end mid-word (300 ms = 3 frames). */
export const OUTPUT_TAIL_FRAMES = 3;
/** A frame whose RMS (of the 16-bit samples) is at or under this is silence. The provider's silent frames are all zero. */
export const OUTPUT_VOICED_RMS = 100;

/** RMS of the little-endian 16-bit samples in `pcm`. */
export function pcm16Rms(pcm: Buffer): number {
  const n = pcm.length >> 1;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) { const v = pcm.readInt16LE(i * 2); sum += v * v; }
  return Math.sqrt(sum / n);
}

const SENTENCE_END = /[.!?]["')\]]*\s*$/;
/** A provider code, type or parameter name only when it looks like one: never free text. */
const shortCode = (v: unknown): string | null => (typeof v === 'string' && /^[\w.:\[\]-]{1,64}$/.test(v) ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

interface Piece { text: string; startMs: number; endMs: number }
/** One thing Nova said: from its first output delta to 900 ms of output quiet. Times are on the session timeline (ms since `session.started`). */
interface Utterance { text: string; startedAt: number; endedAt: number }

export class OpenAiLiveSession extends SessionEmitter implements LiveMeetingSession {
  readonly kind = 'openai' as const;
  readonly acceptsText = false;
  providerSessionId: string | null = null;
  /** Provider `error` events, codes only, the latest MAX_PROVIDER_ERRORS. */
  readonly providerErrors: ProviderErrorInfo[] = [];

  private socket: LiveSocket | null = null;
  private opened = false;
  private started = false;
  private ended = false;
  private startedWall = 0;
  private eventSeq = 0;
  private readonly open = new Set<string>();
  private readonly seenResponses = new Set<string>();
  private tokens: BackendTokens = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  private seconds = 0;
  private input: Piece | null = null;
  private output: Utterance | null = null;
  private outputTimer: unknown = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  /** Output audio: silent frames still owed after the last voiced one, and the frame counter. Audio is never kept. */
  private tailLeft = 0;
  private audioSeq = 0;
  private closing: Promise<void> | null = null;
  private onClosed: (() => void) | null = null;
  private fail: ((e: Error) => void) | null = null;
  private succeed: (() => void) | null = null;
  private readonly clock: () => number;

  constructor(private readonly opts: OpenAiLiveSessionOptions) {
    super();
    this.clock = opts.clock ?? Date.now;
  }

  async start(input: SessionStartInput): Promise<void> {
    if (this.socket) throw new Error('session already started');
    const socket = openLiveSocket();
    this.socket = socket;
    const started = new Promise<void>((resolve, reject) => { this.succeed = resolve; this.fail = reject; });
    const timer = setTimeout(() => this.fail?.(new Error('the live session did not start in time')), this.opts.startTimeoutMs ?? 10_000);
    timer.unref?.();
    socket.addEventListener('open', () => {
      this.opened = true;
      this.send({
        type: 'session.start', event_id: this.eventId(),
        session: liveSocketSessionBody({
          model: this.opts.model, instructions: input.instructions, delegationInstructions: input.backendInstructions,
          voice: this.opts.voice, delegationModel: this.opts.delegationModel, tools: input.tools,
        }),
      });
    });
    socket.addEventListener('message', (msg: { data?: unknown }) => this.onMessage(msg?.data));
    socket.addEventListener('error', () => { this.fail?.(new Error('the live socket failed')); this.dropped('socket-error'); });
    socket.addEventListener('close', () => { this.fail?.(new Error('the live socket closed before the session started')); this.dropped('socket-closed'); });
    try { await started; } catch (e) { this.finish('start-failed'); try { socket.close(1000); } catch { /* already closed */ } throw e; } finally { clearTimeout(timer); }
  }

  appendAudio(pcm24kMono: Buffer): void {
    if (this.ended || !this.opened || pcm24kMono.length === 0) return;
    this.send({ type: 'session.input_audio.append', audio: pcm24kMono.toString('base64') });
  }

  sendText(_userId: string, _text: string): void { throw new SessionTextUnsupported(); }

  answerToolCall(callId: string, output: string): boolean {
    if (this.ended || !this.open.delete(callId)) return false;
    this.send({ type: 'response.item.create', event_id: this.eventId(), item: { type: 'function_call_output', call_id: callId, output } });
    // One continuation per round: only when no other call of the round is still waiting (spec, "Outbound result").
    if (this.open.size === 0) this.send({ type: 'response.create', event_id: this.eventId() });
    return true;
  }

  appendContext(text: string): boolean {
    if (this.ended || !this.opened) return false;
    this.send({ type: 'session.thinking.append', event_id: this.eventId(), delegation_id: null, content: text.slice(0, 2000) });
    return true;
  }

  close(): Promise<void> {
    return (this.closing ??= this.doClose());
  }

  // ---------------------------------------------------------------------------------------------------------------

  private eventId(): string { this.eventSeq += 1; return `ma_${this.eventSeq}`; }

  private send(ev: Record<string, unknown>): void {
    const s = this.socket;
    if (!s || s.readyState !== LIVE_SOCKET_OPEN) return;
    try { s.send(JSON.stringify(ev)); } catch { /* the close handler reports it */ }
  }

  private async doClose(): Promise<void> {
    if (this.ended) return;
    this.flushInput(); this.flushOutput();
    const waited = new Promise<void>((resolve) => { this.onClosed = resolve; });
    this.send({ type: 'session.close' });
    const timer = setTimeout(() => this.onClosed?.(), this.opts.closeTimeoutMs ?? 5000);
    timer.unref?.();
    await waited;
    clearTimeout(timer);
    if (!this.ended) {
      // No `session.closed`: hang up over HTTPS so it cannot keep billing, and report what we last knew.
      const id = this.providerSessionId;
      if (id) { try { await (this.opts.hangup ?? hangupLiveSession)(id); } catch { /* best effort */ } }
      this.finish('close-timeout');
    }
    try { this.socket?.close(1000); } catch { /* already closed */ }
  }

  /**
   * The socket ended and the server did not ask for it. The provider may still hold the session open and keep billing, so hang up
   * over HTTPS (best effort, once), and report usage as the larger of the provider's last figure and the wall clock since
   * `session.started`, rounded up; the report says when the wall clock won.
   */
  private dropped(reason: string): void {
    if (this.ended) return;
    if (this.closing === null && this.started) {
      const wall = Math.ceil(this.sinceStart() / 1000);
      const estimated = wall > this.seconds;
      if (estimated) this.seconds = wall;
      this.emit('usage', { seconds: this.seconds, backendTokens: { ...this.tokens }, ...(estimated ? { estimated: true } : {}) });
      const id = this.providerSessionId;
      if (id) { void Promise.resolve().then(() => (this.opts.hangup ?? hangupLiveSession)(id)).catch(() => undefined); }
    }
    this.finish(reason);
  }

  /** Emit `closed` once, and release anyone waiting on the close. */
  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    this.clearOutputTimer();
    this.input = null; this.output = null; this.open.clear();
    this.emit('closed', { reason });
    this.onClosed?.();
  }

  private onMessage(data: unknown): void {
    let ev: Record<string, unknown>;
    try {
      const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') return;
      ev = parsed as Record<string, unknown>;
    } catch { return; }
    const type = ev['type'];
    switch (type) {
      case 'session.started': {
        const id = (ev['session'] as { id?: unknown } | undefined)?.id;
        if (typeof id === 'string' && /^[\w-]{1,200}$/.test(id)) this.providerSessionId = id;
        this.noteExpiry(ev);
        this.startedWall = this.clock();
        this.started = true;
        this.succeed?.();
        return;
      }
      case 'session.input_transcript.delta': this.onDelta('input', ev); return;
      case 'session.output_transcript.delta': this.onDelta('output', ev); return;
      case 'session.delegation.created': {
        this.flushInput();
        this.emit('delegation', { atMs: this.sinceStart() });
        return;
      }
      case 'response.event': this.onResponseEvent(ev['event']); return;
      case 'session.usage.updated': this.onUsage(ev); return;
      case 'session.output_audio.delta': this.onAudio(ev['delta']); return;
      case 'session.closed': {
        this.noteExpiry(ev);
        this.onUsage(ev);
        this.flushInput(); this.flushOutput();
        const reason = ev['reason'];
        this.finish(typeof reason === 'string' && /^[\w.-]{1,40}$/.test(reason) ? reason : 'closed');
        return;
      }
      case 'error': {
        const code = (ev['code'] ?? (ev['error'] as { code?: unknown } | undefined)?.code);
        // The provider's message text can echo what was said in the call: only a code-shaped value is ever kept or logged.
        const message = shortCode(code) ?? 'error';
        const err = ev['error'] as { code?: unknown; param?: unknown; type?: unknown } | undefined;
        const info: ProviderErrorInfo = { code: shortCode(code), param: shortCode(ev['param'] ?? err?.param), type: shortCode(err?.type) };
        this.providerErrors.push(info);
        if (this.providerErrors.length > MAX_PROVIDER_ERRORS) this.providerErrors.shift();
        if (!this.started) { this.fail?.(new Error(message)); return; }
        this.emit('error', { message, info });
        return;
      }
      default: return;
    }
  }

  /** `session.expires_at` on `session.started` / `session.closed`: epoch seconds or milliseconds, or an ISO string. */
  private noteExpiry(ev: Record<string, unknown>): void {
    const raw = (ev['session'] as { expires_at?: unknown } | undefined)?.expires_at;
    let at = NaN;
    if (typeof raw === 'number') at = raw < 1e11 ? raw * 1000 : raw;
    else if (typeof raw === 'string') at = /^\d+$/.test(raw) ? (Number(raw) < 1e11 ? Number(raw) * 1000 : Number(raw)) : Date.parse(raw);
    if (Number.isFinite(at) && at > 0) this.emit('expires', { atMs: at });
  }

  /**
   * The model's audio: the provider sends one 100 ms frame for every input frame, ALL ZERO unless the model is speaking
   * (measured 13 November). Silence is dropped here so nothing is relayed while it is quiet; a voiced frame and the 300 ms
   * after it go out, the last of them marked `last`. The bytes are decoded, passed on, and forgotten: never logged or written.
   */
  private onAudio(delta: unknown): void {
    if (this.ended || typeof delta !== 'string' || !delta) return;
    const whole = Buffer.from(delta, 'base64');
    const usable = whole.length - (whole.length % 2);
    for (let at = 0; at < usable; at += OUTPUT_FRAME_BYTES) {
      const pcm = whole.subarray(at, Math.min(usable, at + OUTPUT_FRAME_BYTES));
      if (pcm16Rms(pcm) > OUTPUT_VOICED_RMS) this.tailLeft = OUTPUT_TAIL_FRAMES;
      else if (this.tailLeft === 0) continue;
      else this.tailLeft -= 1;
      this.audioSeq += 1;
      const last = this.tailLeft === 0;
      this.emit('outputAudio', { pcm: Buffer.from(pcm), seq: this.audioSeq, ...(last ? { last: true as const } : {}) });
    }
  }

  private sinceStart(): number { return Math.max(0, this.clock() - this.startedWall); }

  private onDelta(side: 'input' | 'output', ev: Record<string, unknown>): void {
    const delta = typeof ev['delta'] === 'string' ? ev['delta'] : '';
    if (!delta) return;
    const startMs = num(ev['start_ms']), endMs = Math.max(startMs, num(ev['end_ms']));
    const gapMs = this.opts.gapMs ?? 1000;
    if (side === 'input') {
      // Input never ends or splits an utterance of Nova's: only output quiet does.
      if (this.input && startMs - this.input.endMs > gapMs) this.flushInput();
      this.input = this.input ? { text: this.input.text + delta, startMs: this.input.startMs, endMs } : { text: delta, startMs, endMs };
      if (SENTENCE_END.test(this.input.text)) this.flushInput(); else this.armIdle();
    } else {
      const at = this.sinceStart();
      this.output = this.output ? { text: this.output.text + delta, startedAt: this.output.startedAt, endedAt: at } : { text: delta, startedAt: at, endedAt: at };
      this.emit('outputTranscript', { text: this.output.text.trim(), final: false });
      this.armOutput();
    }
  }

  private clearOutputTimer(): void {
    if (this.outputTimer === null) return;
    const t = this.opts.timers;
    if (t) t.clear(this.outputTimer); else clearTimeout(this.outputTimer as ReturnType<typeof setTimeout>);
    this.outputTimer = null;
  }

  private armOutput(): void {
    this.clearOutputTimer();
    const fire = () => { this.outputTimer = null; this.flushOutput(); };
    const ms = this.opts.utteranceGapMs ?? 900;
    const t = this.opts.timers;
    if (t) this.outputTimer = t.set(fire, ms);
    else { const h = setTimeout(fire, ms); h.unref?.(); this.outputTimer = h; }
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = null; this.flushInput(); }, this.opts.idleFlushMs ?? 1500);
    this.idle.unref?.();
  }

  private flushInput(): void {
    const p = this.input; this.input = null;
    const text = p?.text.replace(/\s+/g, ' ').trim();
    if (p && text) this.emit('inputTranscript', { text, startMs: p.startMs, endMs: p.endMs });
  }

  private flushOutput(): void {
    this.clearOutputTimer();
    const p = this.output; this.output = null;
    const text = p?.text.replace(/\s+/g, ' ').trim();
    if (p && text) this.emit('outputTranscript', { text, final: true, startedAt: p.startedAt, endedAt: p.endedAt });
  }

  private onResponseEvent(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const e = raw as Record<string, unknown>;
    if (e['type'] === 'response.output_item.done') {
      const item = e['item'] as Record<string, unknown> | undefined;
      if (item?.['type'] !== 'function_call') return;
      const callId = item['call_id'], name = item['name'];
      if (typeof callId !== 'string' || !/^[\w-]{1,128}$/.test(callId) || typeof name !== 'string' || !/^[\w-]{1,64}$/.test(name)) return;
      let args: unknown = null;
      try { args = JSON.parse(typeof item['arguments'] === 'string' ? item['arguments'] : 'null'); } catch { /* null: the orchestrator refuses it */ }
      if (this.open.has(callId)) return;
      this.open.add(callId);
      this.emit('toolCall', { callId, name, args, atMs: this.sinceStart() });
    } else if (e['type'] === 'response.completed') {
      const response = e['response'] as { id?: unknown; usage?: Record<string, unknown> } | undefined;
      const id = typeof response?.id === 'string' ? response.id : null;
      const usage = response?.usage;
      if (!usage || typeof usage !== 'object' || (id && this.seenResponses.has(id))) return;
      if (id) this.seenResponses.add(id);
      const cached = num((usage['input_tokens_details'] as { cached_tokens?: unknown } | undefined)?.cached_tokens);
      this.tokens = {
        inputTokens: this.tokens.inputTokens + Math.floor(num(usage['input_tokens'])),
        outputTokens: this.tokens.outputTokens + Math.floor(num(usage['output_tokens'])),
        cachedTokens: this.tokens.cachedTokens + Math.floor(cached),
      };
    }
  }

  private onUsage(ev: Record<string, unknown>): void {
    const sec = (ev['usage'] as { seconds?: unknown } | undefined)?.seconds;
    if (typeof sec === 'number' && Number.isFinite(sec) && sec >= 0 && sec > this.seconds) this.seconds = sec;
    this.emit('usage', { seconds: this.seconds, backendTokens: { ...this.tokens } });
  }
}
