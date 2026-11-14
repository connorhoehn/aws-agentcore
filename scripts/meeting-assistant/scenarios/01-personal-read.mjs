// personal-read: a person asks Nova aloud for something about themselves that is not the budget (their unread messages). Nova runs the
// read in the asker's own browser. The marker sentence the stand-in returns stands for private content: it must reach only the asker.
// Today the plan keeps only the budget and access-request status private (instructions.ts PRIVATE_TOOLS), so this is expected to FAIL:
// any other read is answered to the whole call.
const MARKER = 'heron-lantern-4417';

export default {
  order: 1, id: 'personal-read', limitSeconds: 60, title: 'a personal (non-budget) read stays with the asker',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'] });
    for (const k of ['vera', 'nora', 'mia']) ctx.lane(k);
    const answer = (out) => { let say = ''; try { say = JSON.parse(out)?.say ?? ''; } catch { say = ''; } return { text: `Here is what I found. ${say}`, frames: 20 }; };
    ctx.say('nora', 800, 'I looked at the calendar sync ticket this morning and it seems fine.');
    ctx.say('vera', 5000, 'Nova, what is in my unread messages?', { dry: { transcript: true, call: { name: 'summary', args: { kind: 'unread' } }, followup: answer, id: 'read' } });
    const runner = ctx.turns('vera', (t) => ({ ok: true, say: `You have two unread messages and the note says ${MARKER}.`, delayMs: 300 }));
    await ctx.run(26_000);
    const turns = runner.log.filter((x) => x.tool === 'summary');
    r.harness('the asker\'s stand-in ran the summary read and posted its result', turns.length === 1 && turns[0].posted === 200, JSON.stringify(turns.map((t) => ({ kind: t.kind, posted: t.posted }))));
    await new Promise((res) => setTimeout(res, 2500));
    await ctx.debug();
    const chat = await call.chatMessages(p.nora);
    const inChat = chat.filter((m) => String(m.message ?? '').includes(MARKER));
    r.expect('the marker never appears in the call chat', inChat.length === 0, inChat.length ? `${inChat.length} message(s) carry it, e.g. labelled ${inChat[0].metadata?.askedByName ?? inChat[0].userId}` : '');
    r.expect('nobody else got it as a private answer', [p.nora, p.mia].every((x) => !x.privateAnswers(call.callId).join(' ').includes(MARKER)));
    r.expect('the asker got it privately', p.vera.privateAnswers(call.callId).join(' ').includes(MARKER), `${p.vera.privateAnswers(call.callId).length} private answer(s)`);
  },
};
