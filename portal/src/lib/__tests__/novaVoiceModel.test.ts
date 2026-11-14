import test from 'node:test';
import assert from 'node:assert/strict';
import { JITTER_BUFFER_S, MAX_LATE_S, SCHEDULE_LEAD_S, parseAudioFrame, pcm16ToFloat32, scheduleFrame, shouldPlay } from '../novaVoiceModel.ts';

const b64 = (vals: number[]) => { const buf = Buffer.alloc(vals.length * 2); vals.forEach((v, i) => buf.writeInt16LE(v, i * 2)); return buf.toString('base64'); };

test('PCM16 little-endian decodes to floats and an odd byte or bad base64 is harmless', () => {
  const f = pcm16ToFloat32(b64([0, 16384, -32768, 32767]));
  assert.equal(f.length, 4);
  assert.equal(f[0], 0); assert.equal(f[1], 0.5); assert.equal(f[2], -1);
  assert.ok(f[3]! < 1 && f[3]! > 0.999);
  assert.equal(pcm16ToFloat32(Buffer.from([1, 0, 7]).toString('base64')).length, 1);
  assert.equal(pcm16ToFloat32('***').length, 0);
});

test('only well-formed assistant-audio frames parse', () => {
  const ok = { type: 'assistant-audio', channel: 'x', data: { callId: 'c1', seq: 3, sampleRate: 24000, pcm: 'AAA=', last: true } };
  assert.deepEqual(parseAudioFrame(ok), { callId: 'c1', seq: 3, sampleRate: 24000, pcm: 'AAA=', last: true });
  assert.equal(parseAudioFrame({ ...ok, type: 'message' }), null);
  assert.equal(parseAudioFrame({ ...ok, data: { ...ok.data, seq: 0 } }), null);
  assert.equal(parseAudioFrame({ ...ok, data: { ...ok.data, pcm: 5 } }), null);
  assert.equal(parseAudioFrame(null), null);
  assert.equal(parseAudioFrame({ ...ok, data: { callId: 'c1', seq: 1, pcm: '' } })?.sampleRate, 24000);
});

test('a frame plays only for this call, newer, unmuted, with voice on and Nova listening', () => {
  const g = { callId: 'c1', frameCallId: 'c1', seq: 5, lastSeq: 4, muted: false, voice: true, listening: true };
  assert.equal(shouldPlay(g), true);
  for (const bad of [{ frameCallId: 'c2' }, { seq: 4 }, { seq: 3 }, { muted: true }, { voice: false }, { listening: false }]) assert.equal(shouldPlay({ ...g, ...bad }), false);
});

test('the first frame waits for the jitter buffer; later ones follow on gaplessly', () => {
  const first = scheduleFrame({ currentTime: 10, nextStartTime: 0, frameSeconds: 0.1, utteranceStarted: false });
  assert.ok(first.play && Math.abs(first.startAt - (10 + JITTER_BUFFER_S)) < 1e-9);
  assert.ok(first.play && Math.abs(first.nextStartTime - 10.25) < 1e-9);
  const next = scheduleFrame({ currentTime: 10.05, nextStartTime: 10.25, frameSeconds: 0.1, utteranceStarted: true });
  assert.ok(next.play && next.startAt === 10.25);
});

test('a frame behind the clock starts just ahead of it, and one more than 500 ms late starts a new utterance', () => {
  const behind = scheduleFrame({ currentTime: 10.3, nextStartTime: 10.2, frameSeconds: 0.1, utteranceStarted: true });
  assert.ok(behind.play && Math.abs(behind.startAt - (10.3 + SCHEDULE_LEAD_S)) < 1e-9);
  const late = scheduleFrame({ currentTime: 11, nextStartTime: 10.4, frameSeconds: 0.1, utteranceStarted: true });
  assert.ok(late.play && Math.abs(late.startAt - (11 + JITTER_BUFFER_S)) < 1e-9, 'a late frame is re-buffered, not dropped');
  assert.ok(MAX_LATE_S === 0.5);
  assert.equal(scheduleFrame({ currentTime: 10, nextStartTime: 0, frameSeconds: 0.1, utteranceStarted: false, running: false }).play, false, 'nothing is scheduled while the context is suspended');
});
