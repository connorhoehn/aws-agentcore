// OpenAiLiveSession against a LOCAL fake of the provider's socket that replays the event shapes recorded in
// docs/voice-navigator-spec.md §1. No real network: the base URL is a loopback server and the key is a test string.
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { _setVoiceWebSocket } from '../../voice/openai.js';
import { OpenAiLiveSession } from '../live-session.js';
import { SessionTextUnsupported, type SessionEvents } from '../session.js';
import type { ResponsesFunctionTool } from '../../voice/catalogue.js';

const KEY = 'sk-test-THE_SERVER_SIDE_KEY_never_in_a_body';
const TOOL: ResponsesFunctionTool = {
  type: 'function', name: 'search', description: 'Search',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
};
const START = { instructions: 'You are Nova.', tools: [TOOL], backendInstructions: 'Run functions.' };

let server: WebSocketServer;
let received: Array<Record<string, unknown>>;
let serverSocket: WebSocket | null;
let headers: Record<string, string | string[] | undefined>;
let url: string | undefined;
let onClientEvent: (ev: Record<string, unknown>, s: WebSocket) => void;
const saved = { key: process.env['OPENAI_API_KEY'], base: process.env['OPENAI_BASE_URL'] };

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const frame = (ev: Record<string, unknown>) => serverSocket!.send(JSON.stringify(ev));

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => server.on('listening', () => r()));
  server.on('connection', (s, req) => {
    serverSocket = s; headers = req.headers; url = req.url;
    s.on('message', (d) => { const ev = JSON.parse(String(d)) as Record<string, unknown>; received.push(ev); onClientEvent(ev, s); });
  });
  process.env['OPENAI_API_KEY'] = KEY;
  process.env['OPENAI_BASE_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  _setVoiceWebSocket(WebSocket as never);
});
afterAll(async () => {
  _setVoiceWebSocket(null);
  for (const c of server.clients) c.terminate();
  await new Promise<void>((r) => server.close(() => r()));
  if (saved.key === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = saved.key;
  if (saved.base === undefined) delete process.env['OPENAI_BASE_URL']; else process.env['OPENAI_BASE_URL'] = saved.base;
});
beforeEach(() => {
  received = []; serverSocket = null;
  onClientEvent = (ev, s) => { if (ev['type'] === 'session.start') s.send(JSON.stringify({ type: 'session.started', client_event_id: ev['event_id'], session: { id: 'live_u0_abc', status: 'active' } })); };
});

function make(over: Partial<ConstructorParameters<typeof OpenAiLiveSession>[0]> = {}) {
  const s = new OpenAiLiveSession({ model: 'gpt-live-1', voice: 'marin', delegationModel: 'gpt-6-luna', idleFlushMs: 40, closeTimeoutMs: 120, ...over });
  const seen: { [K in keyof SessionEvents]: SessionEvents[K][] } = { inputTranscript: [], outputTranscript: [], toolCall: [], delegation: [], usage: [], outputAudio: [], expires: [], closed: [], error: [] };
  (Object.keys(seen) as Array<keyof SessionEvents>).forEach((k) => s.on(k, ((e: never) => { (seen[k] as unknown[]).push(e); }) as never));
  return { s, seen };
}
const callEvent = (callId: string, name: string, args: string) => ({
  type: 'response.event', delegation_id: 'item_1',
  event: { type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call', status: 'completed', call_id: callId, name, arguments: args }, output_index: 0 },
});

describe('start', () => {
  it('opens the primary socket with the bearer key and sends session.start with the delegation tools, no client block', async () => {
    const { s } = make();
    await s.start(START);
    expect(url).toBe('/v1/live/sessions');
    expect(headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(headers['openai-beta']).toBeUndefined();
    const start = received.find((e) => e['type'] === 'session.start') as { session: Record<string, any> };
    expect(start.session['model']).toBe('gpt-live-1');
    expect(start.session['instructions']).toBe('You are Nova.');
    expect(start.session['audio']).toEqual({ output: { voice: 'marin' }, format: { type: 'audio/pcm', rate: 24000 } });
    expect(start.session['client']).toBeUndefined();
    expect(start.session['delegation'].type).toBe('responses');
    expect(start.session['delegation'].responses).toMatchObject({ model: 'gpt-6-luna', instructions: 'Run functions.', tool_choice: 'auto', parallel_tool_calls: false });
    expect(start.session['delegation'].responses.tools[0]).toMatchObject({ type: 'function', name: 'search', strict: true });
    expect(s.providerSessionId).toBe('live_u0_abc');
    await s.close();
  });

  it('rejects when the provider refuses the session, with its code and no key', async () => {
    onClientEvent = (_ev, s) => s.send(JSON.stringify({ type: 'error', code: 'invalid_model', message: 'Model is not supported.' }));
    const { s } = make();
    await expect(s.start(START)).rejects.toThrow(/invalid_model/);
    await expect(s.start(START)).rejects.toThrow(); // a second start is refused
  });

  it('rejects when nothing answers in time', async () => {
    onClientEvent = () => { /* silent */ };
    const { s } = make({ startTimeoutMs: 60 });
    await expect(s.start(START)).rejects.toThrow(/in time/);
  });
});

describe('audio and typed text', () => {
  it('sends audio as base64 session.input_audio.append and ignores empty chunks', async () => {
    const { s } = make();
    await s.start(START);
    s.appendAudio(Buffer.from([1, 2, 3, 4])); s.appendAudio(Buffer.alloc(0));
    await tick();
    const appended = received.filter((e) => e['type'] === 'session.input_audio.append');
    expect(appended).toEqual([{ type: 'session.input_audio.append', audio: Buffer.from([1, 2, 3, 4]).toString('base64') }]);
    await s.close();
  });

  it('does not support a typed request (no text input event is documented)', async () => {
    const { s } = make();
    expect(s.acceptsText).toBe(false);
    expect(() => s.sendText('u-1', 'hello')).toThrow(SessionTextUnsupported);
  });
});

describe('transcripts', () => {
  it('cuts input deltas into pieces at a sentence end and at a gap, with start and end offsets', async () => {
    const { s, seen } = make();
    await s.start(START);
    for (const [d, a, b] of [[' Nova', 1800, 2000], [', what', 2000, 2200], [' is it?', 2200, 2400], [' ok', 5000, 5200], [' then', 5200, 5400]] as const) {
      frame({ type: 'session.input_transcript.delta', start_ms: a, end_ms: b, delta: d });
    }
    await tick(120);
    expect(seen.inputTranscript).toEqual([
      { text: 'Nova, what is it?', startMs: 1800, endMs: 2400 },
      { text: 'ok then', startMs: 5000, endMs: 5400 },
    ]);
    await s.close();
  });

  it('streams output text; an utterance ends only after 900 ms without an output delta, never when people speak', async () => {
    let handle = 0; const timers = new Map<number, () => void>();
    let wall = 1000;
    const { s, seen } = make({ clock: () => wall, timers: { set: (fn) => { handle += 1; timers.set(handle, fn); return handle; }, clear: (h) => { timers.delete(h as number); } } });
    await s.start(START);
    wall = 1500;
    frame({ type: 'session.output_transcript.delta', start_ms: 3200, end_ms: 3400, delta: ' No problem' });
    frame({ type: 'session.input_transcript.delta', start_ms: 3500, end_ms: 3600, delta: ' Hey' });
    await tick();
    wall = 1900;
    frame({ type: 'session.output_transcript.delta', start_ms: 3400, end_ms: 3600, delta: '.' });
    frame({ type: 'session.input_transcript.delta', start_ms: 3700, end_ms: 3800, delta: ' there.' });
    await tick();
    expect(seen.outputTranscript.map((o) => [o.text, o.final])).toEqual([['No problem', false], ['No problem.', false]]);
    expect(timers.size).toBe(1); // one output timer, re-armed by each delta
    for (const fn of [...timers.values()]) fn(); // 900 ms of output quiet
    expect(seen.outputTranscript.at(-1)).toEqual({ text: 'No problem.', final: true, startedAt: 500, endedAt: 900 });
    expect(seen.outputTranscript.filter((o) => o.final)).toHaveLength(1);
    frame({ type: 'session.delegation.created', offset_ms: 4400, delegation: { id: 'item_1', type: 'delegation', target: 'responses' } });
    await tick();
    expect(seen.delegation).toHaveLength(1);
    expect(seen.inputTranscript.map((i) => i.text)).toEqual(['Hey there.']);
    await s.close();
  });

  it('an utterance still being spoken when the session closes is emitted once at close', async () => {
    const { s, seen } = make({ utteranceGapMs: 60_000 });
    await s.start(START);
    frame({ type: 'session.output_transcript.delta', start_ms: 0, end_ms: 100, delta: 'Goodbye' });
    await tick();
    await s.close();
    expect(seen.outputTranscript.filter((o) => o.final).map((o) => o.text)).toEqual(['Goodbye']);
  });
});

describe('output audio', () => {
  const pcmB64 = (amp: number, bytes = 4800) => {
    const b = Buffer.alloc(bytes);
    if (amp) for (let i = 0; i < Math.floor(bytes / 2); i += 1) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
    return b.toString('base64');
  };
  const delta = (amp: number, bytes?: number) => frame({ type: 'session.output_audio.delta', delta: pcmB64(amp, bytes), event_id: 'e' });

  it('drops silent frames, relays voiced frames and a 300 ms tail, marks the last, and starts over for the next utterance', async () => {
    const { s, seen } = make();
    await s.start(START);
    for (let i = 0; i < 5; i += 1) delta(0);
    expect(seen.outputAudio).toHaveLength(0);
    delta(3000); delta(3000);
    for (let i = 0; i < 6; i += 1) delta(0);
    await tick(20);
    expect(seen.outputAudio.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(seen.outputAudio.map((f) => f.last === true)).toEqual([false, false, false, false, true]);
    expect(seen.outputAudio.every((f) => f.pcm.length === 4800)).toBe(true);
    delta(3000); delta(0); delta(3000); delta(0); delta(0); delta(0);
    await tick(20);
    expect(seen.outputAudio.slice(5).map((f) => f.last === true)).toEqual([false, false, false, false, false, true]);
    await s.close();
  });

  it('cuts an oversized delta into frames of at most 100 ms and ignores a bad one', async () => {
    const { s, seen } = make();
    await s.start(START);
    delta(3000, 9601); frame({ type: 'session.output_audio.delta', delta: 42 }); frame({ type: 'session.output_audio.delta' });
    await tick(20);
    expect(seen.outputAudio.map((f) => f.pcm.length)).toEqual([4800, 4800]);
    await s.close();
  });

  it('reports expires_at from session.started (seconds, ms or ISO) as epoch milliseconds', async () => {
    for (const [raw, want] of [[1_800_000_000, 1_800_000_000_000], [1_800_000_000_000, 1_800_000_000_000], ['2027-01-15T08:00:00Z', Date.parse('2027-01-15T08:00:00Z')]] as const) {
      onClientEvent = (ev, sock) => { if (ev['type'] === 'session.start') sock.send(JSON.stringify({ type: 'session.started', session: { id: 'live_u0_abc', expires_at: raw } })); };
      const { s, seen } = make();
      await s.start(START);
      expect(seen.expires).toEqual([{ atMs: want }]);
      await s.close();
    }
  });
});

describe('tool calls', () => {
  it('raises the nested function call once and answers it with item.create then exactly one response.create', async () => {
    const { s, seen } = make();
    await s.start(START);
    frame(callEvent('call_1', 'search', '{"query":"Kubernetes experts"}'));
    frame(callEvent('call_1', 'search', '{"query":"Kubernetes experts"}')); // a repeat of the same call is ignored
    await tick();
    expect(seen.toolCall).toHaveLength(1);
    expect(seen.toolCall[0]).toMatchObject({ callId: 'call_1', name: 'search', args: { query: 'Kubernetes experts' } });
    expect(seen.toolCall[0]!.askedBy).toBeUndefined();
    expect(s.answerToolCall('call_1', '{"rows":[]}')).toBe(true);
    expect(s.answerToolCall('call_1', '{"rows":[]}')).toBe(false);
    expect(s.answerToolCall('call_unknown', '{}')).toBe(false);
    await tick();
    const out = received.filter((e) => e['type'] === 'response.item.create' || e['type'] === 'response.create');
    expect(out.map((e) => e['type'])).toEqual(['response.item.create', 'response.create']);
    expect(out[0]).toMatchObject({ item: { type: 'function_call_output', call_id: 'call_1', output: '{"rows":[]}' } });
    await s.close();
  });

  it('invalid arguments arrive as null for the orchestrator to refuse, and a non-function item is not a call', async () => {
    const { s, seen } = make();
    await s.start(START);
    frame(callEvent('call_2', 'search', '{not json'));
    frame({ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1' } } });
    await tick();
    expect(seen.toolCall).toHaveLength(1);
    expect(seen.toolCall[0]!.args).toBeNull();
    await s.close();
  });

  it('holds the continuation until every open call of the round is answered', async () => {
    const { s } = make();
    await s.start(START);
    frame(callEvent('call_a', 'search', '{"query":"a"}')); frame(callEvent('call_b', 'search', '{"query":"b"}'));
    await tick();
    s.answerToolCall('call_a', '{}'); await tick();
    expect(received.filter((e) => e['type'] === 'response.create')).toHaveLength(0);
    s.answerToolCall('call_b', '{}'); await tick();
    expect(received.filter((e) => e['type'] === 'response.create')).toHaveLength(1);
    await s.close();
  });

  it('sends silent context as session.thinking.append with no delegation id', async () => {
    const { s } = make();
    await s.start(START);
    expect(s.appendContext('The card was declined.')).toBe(true);
    await tick();
    expect(received.find((e) => e['type'] === 'session.thinking.append')).toMatchObject({ delegation_id: null, content: 'The card was declined.' });
    await s.close();
  });
});

describe('usage and close', () => {
  it('reports cumulative seconds and each backend response once, and closes with the final usage', async () => {
    onClientEvent = (ev, sock) => {
      if (ev['type'] === 'session.start') sock.send(JSON.stringify({ type: 'session.started', session: { id: 'live_u0_abc' } }));
      if (ev['type'] === 'session.close') sock.send(JSON.stringify({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 42 } }));
    };
    const { s, seen } = make();
    await s.start(START);
    frame({ type: 'session.usage.updated', usage: { seconds: 20 } });
    const completed = { type: 'response.event', event: { type: 'response.completed', response: { id: 'resp_1', output: [], usage: { input_tokens: 1060, output_tokens: 20, input_tokens_details: { cached_tokens: 100 } } } } };
    frame(completed); frame(completed);
    frame({ type: 'session.usage.updated', usage: { seconds: 15 } }); // never goes backwards
    await tick();
    expect(seen.usage.at(-1)).toEqual({ seconds: 20, backendTokens: { inputTokens: 1060, outputTokens: 20, cachedTokens: 100 } });
    await s.close();
    expect(seen.usage.at(-1)!.seconds).toBe(42);
    expect(seen.closed).toEqual([{ reason: 'close_requested' }]);
    await s.close(); // idempotent
    expect(seen.closed).toHaveLength(1);
  });

  it('falls back to the HTTPS hangup when session.closed never arrives, and reports the last usage', async () => {
    const hangup = jest.fn(async () => true);
    const { s, seen } = make({ hangup });
    await s.start(START);
    frame({ type: 'session.usage.updated', usage: { seconds: 30 } });
    await tick();
    await s.close();
    expect(hangup).toHaveBeenCalledWith('live_u0_abc');
    expect(seen.closed).toEqual([{ reason: 'close-timeout' }]);
    expect(seen.usage.at(-1)!.seconds).toBe(30);
    expect(s.answerToolCall('call_x', '{}')).toBe(false);
  });

  it('an unexpected close hangs up once over HTTPS and books the larger of the provider figure and the wall clock', async () => {
    const hangup = jest.fn(async () => true);
    let now = 1_000_000;
    const { s, seen } = make({ hangup, clock: () => now });
    await s.start(START);
    frame({ type: 'session.usage.updated', usage: { seconds: 30 } });
    await tick();
    now += 90_400;
    serverSocket!.terminate(); await tick(60);
    expect(hangup).toHaveBeenCalledTimes(1);
    expect(hangup).toHaveBeenCalledWith('live_u0_abc');
    expect(seen.usage.at(-1)).toMatchObject({ seconds: 91, estimated: true });
    expect(seen.closed).toHaveLength(1);
    await s.close();
    expect(hangup).toHaveBeenCalledTimes(1);
  });

  it('an unexpected close keeps the provider figure when it is the larger, and says nothing about an estimate', async () => {
    const hangup = jest.fn(async () => true);
    let now = 1_000_000;
    const { s, seen } = make({ hangup, clock: () => now });
    await s.start(START);
    frame({ type: 'session.usage.updated', usage: { seconds: 30 } });
    await tick();
    now += 10_000;
    serverSocket!.terminate(); await tick(60);
    expect(seen.usage.at(-1)).toEqual({ seconds: 30, backendTokens: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } });
    expect(hangup).toHaveBeenCalledTimes(1);
  });

  it('a socket that drops reports closed once and later answers are refused', async () => {
    const { s, seen } = make();
    await s.start(START);
    frame(callEvent('call_9', 'search', '{"query":"x"}')); await tick();
    serverSocket!.terminate(); await tick(60);
    expect(seen.closed).toHaveLength(1);
    expect(s.answerToolCall('call_9', '{}')).toBe(false);
  });

  it('keeps a bounded list of provider errors as codes only, never the message or anything that is not shaped like a code', async () => {
    const { s, seen } = make();
    await s.start(START);
    frame({ type: 'error', code: 'invalid_value', param: 'session.thinking', message: 'secret words from the call', error: { type: 'invalid_request_error' } });
    frame({ type: 'error', code: 'has spaces and secret words', message: 'x' });
    for (let i = 0; i < 30; i += 1) frame({ type: 'error', code: `e_${i}` });
    await tick();
    expect(s.providerErrors).toHaveLength(20);
    expect(s.providerErrors.at(-1)).toEqual({ code: 'e_29', param: null, type: null });
    expect(seen.error[0]!.info).toEqual({ code: 'invalid_value', param: 'session.thinking', type: 'invalid_request_error' });
    expect(seen.error[1]!.info!.code).toBeNull();
    expect(JSON.stringify(s.providerErrors)).not.toMatch(/secret/);
    await s.close();
  });
  it('surfaces a provider error after start as an event carrying the code and never the provider\'s message text', async () => {
    const { s, seen } = make();
    await s.start(START);
    frame({ type: 'error', code: 'rate_limited', message: 'x'.repeat(500) });
    await tick();
    expect(seen.error).toHaveLength(1);
    expect(seen.error[0]!.message).toBe('rate_limited');
    await s.close();
  });
});
