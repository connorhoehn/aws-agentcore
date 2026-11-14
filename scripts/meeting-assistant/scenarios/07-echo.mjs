// echo: Nova speaks aloud (voice on) and Nora's laptop plays it back into her own microphone, quieter and a little late, as a speaker does.
// The harness takes the voice frames Nora's socket receives, resamples them to 16 kHz, attenuates them by 12 dB, delays them and mixes
// them into Nora's lane. Pass 1 uses a 400 ms delay, pass 2 a 900 ms delay. Nova's own words must not become Nora's lines, must not be
// answered, must not start a tool call, and a real line Nora speaks one second after the echo ends must still be stored under her.
import { attachEcho } from '../lib/harness.mjs';

export default {
  order: 7, id: 'echo', limitSeconds: 120, title: 'Nova\'s voice heard back through a microphone is not a person\'s line',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'], voice: true });
    for (const k of ['vera', 'nora', 'mia']) ctx.lane(k);
    const passes = [
      { n: 1, delay: 400, q: 'Nova, what is the capital of Portugal?', a: 'The capital of Portugal is Lisbon. Nova can tell you more about the city if you like.', word: 'Lisbon', follow: 'I booked the train for the team offsite on Friday.', followKey: 'Friday', start: 3000 },
      { n: 2, delay: 900, q: 'Nova, what is the capital of Spain?', a: 'The capital of Spain is Madrid. Nova can tell you more about the city if you like.', word: 'Madrid', follow: 'The offsite agenda still needs a lunch break on Thursday.', followKey: 'Thursday', start: 32_000 },
    ];
    ctx.world.provider?.addEcho({ ofId: 'q1', delayMs: 400 });
    ctx.world.provider?.addEcho({ ofId: 'q2', delayMs: 900 });
    for (const x of passes) ctx.say('vera', x.start, x.q, { dry: { id: `q${x.n}`, reply: { text: x.a, frames: 40 }, delayMs: 300 } });
    ctx.begin();
    const results = [];
    for (const x of passes) {
      const ctl = attachEcho({ clock: ctx.world.clock, person: p.nora, lane: ctx.lane('nora'), delayMs: x.delay });
      // Wait for Nova's whole answer to arrive at Nora's socket (voice frames end with a `last` one), then for its echo to finish.
      await ctx.until(x.start);
      const got = await (async () => { const end = Date.now() + 25_000; while (Date.now() < end) { if (ctl.frames > 0 && ctl.lastSeen) return true; await new Promise((res) => setTimeout(res, 150)); } return false; })();
      const echoEnd = ctl.lastEndMs;
      const afterMs = Math.max(ctx.world.clock.now() + 500, echoEnd + 1000);
      const follow = ctx.say('nora', afterMs, x.follow);
      await ctx.until(follow.endMs + 3500);
      ctl.detach();
      results.push({ x, ctl, got, echoEnd, follow });
    }
    await ctx.until(Math.max(...results.map((z) => z.follow.endMs)) + 5000);
    await ctx.world.stopLanes();
    await ctx.debug();

    const stored = await call.transcript();
    const chat = await call.chatMessages(p.vera);
    const state = await call.state();
    const replies = chat.filter((m) => m.metadata?.kind === 'assistant-reply');
    for (const { x, ctl, got, follow } of results) {
      r.harness(`pass ${x.n}: Nora's socket received Nova's voice and the harness mixed it into her lane`, got && ctl.frames >= 20, `${ctl.frames} frames, ${ctl.lastEndMs - ctl.firstAtMs} ms laid in`);
      const echoLines = stored.filter((s) => s.text.includes(x.word) && s.userId === 'u-nora');
      r.expect(`pass ${x.n} (${x.delay} ms): nothing of Nova's answer is stored as Nora's line`, echoLines.length === 0, echoLines.length ? `${echoLines.length} line(s): "${echoLines[0].text.slice(0, 50)}"` : '');
      const real = stored.find((s) => s.text.includes(x.followKey));
      r.expect(`pass ${x.n}: Nora's own line one second after the echo is stored under Nora`, !!real && real.userId === 'u-nora', real ? `${real.userId}` : 'not stored');
      void follow;
    }
    r.expect('Nova did not answer itself: one reply per question, no more', replies.filter((m) => /capital of/i.test(String(m.message))).length === 2 && replies.length === 2, `${replies.length} replies: ${replies.map((m) => `${m.metadata.askedBy}`).join(',')}`);
    r.expect('no request was counted beyond Vera\'s two questions', state?.counters?.requests === 2, `requests ${state?.counters?.requests}`);
    r.expect('no tool call followed, made or refused', (ctx.world.provider?.seen.calls.length ?? 0) === 0 && state?.refusedCalls === 0, `provider calls ${ctx.world.provider?.seen.calls.length ?? 'n/a'}, refused ${state?.refusedCalls}`);
    r.measure('echo lines the guard dropped (echoLinesDropped)', state?.echoLinesDropped ?? -1);
  },
};
