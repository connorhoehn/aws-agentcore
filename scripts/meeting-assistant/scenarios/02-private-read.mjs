// private-read: Vera asks aloud how much budget she has (a private read: instructions.ts PRIVATE_TOOLS), and Nora asks a plain question
// straight after. The figure must reach only Vera; Nora's answer is posted to the call, labelled with Nora, without the figure.
const FIGURE = '9317 dollars';

export default {
  order: 2, id: 'private-read', limitSeconds: 60, title: 'a budget answer reaches only the asker; the next public answer is Nora\'s',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'] });
    for (const k of ['vera', 'nora', 'mia']) ctx.lane(k);
    ctx.say('mia', 300, 'The release notes for the scheduling app are almost done.');
    ctx.say('vera', 6000, 'Nova, how much budget do I have left this month?', { dry: { call: { name: 'budget', args: { scope: 'me' } }, followup: 'I sent that to you privately.', id: 'budget' } });
    ctx.say('nora', 13_000, 'Nova, what is two plus two?', { dry: { reply: { text: 'Two plus two is four.', frames: 15 } } });
    const runner = ctx.turns('vera', () => ({ ok: true, say: `You have ${FIGURE} left this month.`, delayMs: 300 }));
    await ctx.run(30_000);
    await new Promise((res) => setTimeout(res, 2500));
    await ctx.debug();
    const turns = runner.log.filter((x) => x.tool === 'budget');
    r.harness('Vera\'s stand-in ran the budget read as a private read and posted its result', turns.length === 1 && turns[0].posted === 200 && turns[0].kind === 'private-read', JSON.stringify(turns.map((t) => ({ kind: t.kind, posted: t.posted }))));
    const chat = await call.chatMessages(p.nora);
    const labelled = (m) => `${m.metadata?.askedBy ?? ''}`;
    const withFigure = chat.filter((m) => /9317/.test(String(m.message ?? '')));
    r.expect('the figure is not in the call chat', withFigure.length === 0, withFigure.length ? `${withFigure.length} message(s) carry it` : '');
    r.expect('Nora and Mia received no private answer carrying the figure', [p.nora, p.mia].every((x) => !/9317/.test(x.privateAnswers(call.callId).join(' '))));
    r.expect('Vera received the figure as her own private answer', /9317/.test(p.vera.privateAnswers(call.callId).join(' ')), `${p.vera.privateAnswers(call.callId).length} private answer(s)`);
    const calls = chat.filter((m) => m.metadata?.kind === 'assistant-reply');
    const second = calls.find((m) => /four/i.test(String(m.message)));
    r.expect('the call chat has only the fixed line for Vera\'s private answer', calls.some((m) => /^Answered privately for Vera/.test(String(m.message))), calls.map((m) => String(m.message).slice(0, 40)).join(' | '));
    r.expect('Nora\'s plain question is answered in the call chat, labelled with Nora', !!second && labelled(second) === 'u-nora', second ? `labelled ${labelled(second)} (${second.metadata?.askedByName})` : 'no reply');
    r.expect('Nora\'s answer does not contain the figure', !!second && !/9317/.test(String(second.message)));
  },
};
