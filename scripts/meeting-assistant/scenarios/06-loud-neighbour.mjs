// loud-neighbour: Vera makes a short, quiet request to Nova while Nora's microphone is much louder than hers.
//  pass 1: Nora's lane carries keyboard clicks at four times Vera's level while Vera asks
//  pass 2: Nora speaks at four times Vera's gain just before and just after Vera's request
// In both, the asker must be Vera and the request must be stored under Vera.
import { synth, msOf, rms, gained, PEOPLE } from '../lib/harness.mjs';

export default {
  order: 6, id: 'loud-neighbour', limitSeconds: 90, title: 'a quiet request next to a loud neighbour is still Vera\'s',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'] });
    const veraGain = 0.25, noraGain = 1.0;
    const q1 = 'Nova, what is two plus two?', q2 = 'Nova, what is three plus three?';
    const veraLevel = rms(gained(synth(q1, { voice: PEOPLE.vera.voice, dir: ctx.world.dir }).pcm, veraGain));
    // Click bursts: their peak is four times Vera's speech level (RMS), so their energy is well above hers in the mixed signal.
    ctx.lane('nora', { noise: { kind: 'clicks', level: Math.round(veraLevel * 4), fromMs: 3000, toMs: 11_000 } });
    ctx.lane('vera'); ctx.lane('mia');
    r.measure('Vera\'s speech level (rms)', veraLevel); r.measure('click peak (rms x 4)', Math.round(veraLevel * 4));
    ctx.at(500);
    ctx.next('mia', 'Let me share my screen so we can look at the sign in page.', { gap: 300 });
    const req1 = ctx.say('vera', 5000, q1, { gain: veraGain, dry: { reply: { text: 'Two plus two is four.', frames: 12 } } });
    // Pass 2, after the clicks stop: Nora speaks at four times Vera's gain right before and right after her request.
    const d = msOf(synth(q2, { voice: PEOPLE.vera.voice, dir: ctx.world.dir }).pcm);
    const startReq2 = 20_000;
    const before = ctx.say('nora', startReq2 - 400 - msOf(synth('I will check the digest after lunch today.', { voice: PEOPLE.nora.voice, dir: ctx.world.dir }).pcm), 'I will check the digest after lunch today.', { gain: noraGain });
    const req2 = ctx.say('vera', startReq2, q2, { gain: veraGain, dry: { reply: { text: 'Three plus three is six.', frames: 12 } } });
    const after = ctx.say('nora', req2.endMs + 400, 'Thanks, that settles the plan for the week.', { gain: noraGain });
    ctx.begin();
    await ctx.until(after.endMs + 9000);
    await ctx.world.stopLanes();
    await ctx.debug();

    const stored = await call.transcript();
    const line = (text) => stored.find((s) => s.text.includes(text));
    for (const [label, q] of [['pass 1 (clicks)', q1], ['pass 2 (loud speech either side)', q2]]) {
      const l = line(q.slice(6, 24));
      r.expect(`${label}: the request is stored under Vera alone`, !!l && l.userId === 'u-vera' && (l.speakers?.length ?? 0) <= 1, l ? `${l.userId} ${JSON.stringify(l.speakers ?? [])}` : 'no such line');
    }
    const chat = await call.chatMessages(p.vera);
    const replies = chat.filter((m) => m.metadata?.kind === 'assistant-reply');
    for (const [label, re] of [['pass 1', /four/i], ['pass 2', /six/i]]) {
      const a = replies.find((m) => re.test(String(m.message)));
      r.expect(`${label}: the asker is Vera`, !!a && a.metadata.askedBy === 'u-vera', a ? `labelled ${a.metadata.askedBy}` : 'no reply');
    }
    for (const [label, ev] of [['Nora\'s line before', before], ['Nora\'s line after', after]]) {
      const l = stored.find((s) => s.text.includes(ev.text.slice(0, 20)));
      r.measure(`${label} is stored under`, l ? `${l.userId}${(l.speakers?.length ?? 0) > 1 ? ' (split)' : ''}` : 'nobody (missing)');
    }
    void [req1, d];
  },
};
