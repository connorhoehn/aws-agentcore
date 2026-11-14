// late-joiner: Mia takes a seat after Nova was invited and has not acknowledged the notice. Her audio must not reach Nova: nothing she
// says is stored, nothing answers it, and the unacknowledged counter rises. Once she acknowledges, her request is answered, labelled
// with her.
export default {
  order: 9, id: 'late-joiner', limitSeconds: 120, title: 'an unacknowledged late joiner is not heard until she acknowledges',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'], late: ['mia'] });
    // Mia joins after the invite: a seat, the chat, her participant id bound; no acknowledgement.
    await call.seat(p.mia); await call.chatJoin(p.mia); await call.bind(p.mia);
    for (const k of ['vera', 'nora', 'mia']) ctx.lane(k);
    ctx.at(500);
    ctx.next('vera', 'Mia just joined us, so let me recap the plan for the launch.', { gap: 500 });
    const m1 = ctx.next('mia', 'Nova, what is two plus two?', { gap: 2500, dry: { reply: { text: 'Two plus two is four.', frames: 12 } } });
    ctx.begin();
    await ctx.until(m1.endMs + 7000);
    const mid = await call.state(p.mia);
    const midAudio = await call.audio();
    const chatMid = await call.chatMessages(p.vera);
    const linesMid = await call.transcript();
    r.expect('Mia\'s unacknowledged request stored no line for her', !linesMid.some((l) => l.userId === 'u-mia' || /two plus two/i.test(l.text)), `${linesMid.filter((l) => l.userId === 'u-mia').length} line(s)`);
    r.expect('nothing answered her request', !chatMid.some((m) => m.metadata?.kind === 'assistant-reply'), `${chatMid.filter((m) => m.metadata?.kind === 'assistant-reply').length} reply(ies)`);
    r.expect('the unacknowledged counter rose', (midAudio?.counters?.unackedChunks ?? 0) > 0, `unackedChunks ${midAudio?.counters?.unackedChunks}`);
    r.expect('the state says Mia still owes an acknowledgement', mid?.youMustAck === true && (mid?.mustAck ?? []).includes('u-mia'), `mustAck ${JSON.stringify(mid?.mustAck)}`);
    r.measure('chunks from Mia dropped as unacknowledged', midAudio?.counters?.unackedChunks ?? -1);
    if (ctx.dry) r.harness('the provider heard nothing of her first request (it was dropped before the mix)', ctx.world.provider.seen.unheard >= 1, `${ctx.world.provider.seen.unheard} unheard span(s)`);
    const ack = await call.ack(p.mia);
    r.harness('Mia acknowledges the notice', ack.status === 200, `HTTP ${ack.status}`);
    await ctx.until(ctx.world.clock.now() + 2500);
    const m2 = ctx.say('mia', ctx.world.clock.now() + 1200, 'Nova, what is the capital of Portugal?', { dry: { reply: { text: 'The capital of Portugal is Lisbon.', frames: 15 } } });
    await ctx.until(m2.endMs + 8000);
    await ctx.world.stopLanes();
    await ctx.debug();
    const chat = await call.chatMessages(p.vera);
    const answer = chat.find((m) => m.metadata?.kind === 'assistant-reply' && /lisbon/i.test(String(m.message)));
    r.expect('after acknowledging, her request is answered, labelled with Mia', !!answer && answer.metadata.askedBy === 'u-mia', answer ? `labelled ${answer.metadata.askedBy}` : 'no reply');
    const lines = await call.transcript();
    const line = lines.find((l) => /capital of portugal/i.test(l.text));
    r.expect('her second request is stored under her', !!line && line.userId === 'u-mia', line ? line.userId : 'not stored');
  },
};
