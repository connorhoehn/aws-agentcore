// two-askers: more than one person talks to Nova close together, and each answer, card and turn must belong to the person who asked.
//  (a) two plain questions with 1.5 s between them: two replies, each labelled with its asker and holding its own answer
//  (b) Vera asks for a work item; while it is being worked on, Nora addresses Nova with something else: the card and the turn are Vera's
//  (c) Vera's read waits 20 s on her own browser; meanwhile Nora asks a plain question, which must still be answered in the call
export default {
  order: 3, id: 'two-askers', limitSeconds: 120, title: 'overlapping askers: each answer, card and turn is its asker\'s',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'] });
    for (const k of ['vera', 'nora', 'mia']) ctx.lane(k);
    // (a)
    ctx.at(500);
    ctx.next('mia', 'We should look at the reminder emails before the release.', { gap: 300 });
    const a1 = ctx.next('vera', 'Nova, what is two plus two?', { gap: 1500, dry: { reply: { text: 'Two plus two is four.', frames: 12 } } });
    const a2 = ctx.next('nora', 'Nova, what is the capital of France?', { gap: 1500, dry: { reply: { text: 'The capital of France is Paris.', frames: 12 } } });
    // (b)
    const b1 = ctx.next('vera', 'Nova, create a work item for the calendar sync bug.', { gap: 6000, dry: { delayMs: 3500, call: { name: 'create', args: { kind: 'work-item', fields: { title: 'Calendar sync bug' } } }, followup: 'I have asked Vera to confirm that.' } });
    const b2 = ctx.next('nora', 'Nova, how is the weather in Lisbon today?', { gap: 300, dry: { reply: { text: 'It is sunny in Lisbon today.', frames: 12 } } });
    // (c)
    const c1 = ctx.next('vera', 'Nova, who is online right now?', { gap: 9000, dry: { call: { name: 'activity', args: { scope: 'online' } }, followup: (out) => ({ text: `Right now: ${JSON.parse(out)?.say ?? 'nobody'}`, frames: 15 }) } });
    const c2 = ctx.next('nora', 'Nova, what is seven times eight?', { gap: 3500, dry: { reply: { text: 'Seven times eight is fifty six.', frames: 12 } } });
    const veraRuns = ctx.turns('vera', (t) => (t.tool.name === 'activity' ? { ok: true, say: 'Vera and Nora are online.', delayMs: 20_000 } : { withhold: true }));
    const noraRuns = ctx.turns('nora', () => ({ withhold: true }));
    ctx.begin();
    await ctx.until(c2.endMs + 30_000);
    await ctx.world.stopLanes();
    await ctx.debug();

    const chat = await call.chatMessages(p.vera);
    const replies = chat.filter((m) => m.metadata?.kind === 'assistant-reply');
    const by = (re) => replies.find((m) => re.test(String(m.message)));
    const four = by(/two plus two is four/i), paris = by(/paris/i);
    r.expect('(a) the first question is answered, labelled with Vera', !!four && four.metadata.askedBy === 'u-vera', four ? `labelled ${four.metadata.askedBy}` : 'no reply');
    r.expect('(a) the second question is answered, labelled with Nora', !!paris && paris.metadata.askedBy === 'u-nora', paris ? `labelled ${paris.metadata.askedBy}` : 'no reply');
    r.expect('(a) there are exactly two replies for the two questions', replies.filter((m) => /four|paris/i.test(String(m.message))).length === 2);
    const cards = chat.filter((m) => m.metadata?.kind === 'assistant-action');
    const card = cards.find((m) => m.metadata?.tool?.name === 'create');
    r.expect('(b) a card was offered for the work item', !!card, `${cards.length} card(s)`);
    r.expect('(b) the card is Vera\'s, who asked for it', !!card && card.metadata.askedBy === 'u-vera', card ? `askedBy ${card.metadata.askedBy}, ${card.metadata.status}` : 'no card');
    const stateAfter = await call.state();
    r.measure('refused calls so far', stateAfter?.refusedCalls ?? -1);
    const seven = by(/fifty six/i);
    r.expect('(c) Nora\'s plain question is answered in the call chat while Vera\'s read waits', !!seven && seven.metadata.askedBy === 'u-nora', seven ? `labelled ${seven.metadata.askedBy}` : 'no reply posted');
    const online = by(/right now/i);
    r.expect('(c) Vera\'s own read is answered to the call once her browser reports, labelled with Vera', !!online && online.metadata.askedBy === 'u-vera', online ? `labelled ${online.metadata.askedBy}` : 'no reply');
    const waited = veraRuns.log.find((x) => x.tool === 'activity');
    r.harness('Vera\'s stand-in held the read about 20 s and then posted it', !!waited && waited.posted === 200, JSON.stringify(waited ? { posted: waited.posted } : null));
    r.harness('Nora\'s stand-in never ran anything', noraRuns.log.every((x) => x.withheld));
    void [a1, a2, b1, b2, c1];
  },
};
