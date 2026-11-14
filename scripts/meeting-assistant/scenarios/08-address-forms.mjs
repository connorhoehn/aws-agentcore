// address-forms: the ways people really address Nova, and the ways they do not.
//  addressed: the name at the end of the sentence; "Hey Nova"; "Nova?" then a two second pause then the question
//  not addressed: a question to a colleague named Nora ("Nora, what do you think?"); someone talking about Nova in the third person
// An addressed form is answered, labelled with who spoke it; a form that is not addressed raises no request and is not answered.
export default {
  order: 8, id: 'address-forms', limitSeconds: 120, title: 'the name at the end, Hey Nova, Nova? and pause; Nora and third-person talk are not requests',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'] });
    for (const k of ['vera', 'nora', 'mia']) ctx.lane(k);
    ctx.at(500);
    const f1 = ctx.next('vera', 'What is the capital of Portugal, Nova?', { gap: 1500, dry: { reply: { text: 'The capital of Portugal is Lisbon.', frames: 15 } } });
    const f2 = ctx.next('nora', 'Hey Nova, what is two plus two?', { gap: 7000, dry: { reply: { text: 'Two plus two is four.', frames: 12 } } });
    const f3a = ctx.next('mia', 'Nova?', { gap: 7000 });
    const f3b = ctx.next('mia', 'What is the capital of Spain?', { gap: 2000, dry: { reply: { text: 'The capital of Spain is Madrid.', frames: 15 } } });
    const f4 = ctx.next('vera', 'Nora, what do you think about the reminder wording?', { gap: 8000 });
    const f4b = ctx.next('nora', 'I think the wording is clear enough for the first release.', { gap: 1500 });
    const f5 = ctx.next('mia', 'Last week Nova helped Vera with the plan for the launch.', { gap: 6000 });
    r.note('in --dry the provider only answers the addressed forms the scenario scripts; whether a real model stays silent for the others is what the paid run judges (the request counter is judged either way)');
    ctx.begin();
    await ctx.until(f4.atMs - 300); const s4a = await call.state();
    await ctx.until(f4b.endMs + 4000); const s4b = await call.state();
    await ctx.until(f5.endMs + 5000); const s5 = await call.state();
    await ctx.until(f5.endMs + 7000);
    await ctx.world.stopLanes();
    await ctx.debug();

    const chat = await call.chatMessages(p.vera);
    const replies = chat.filter((m) => m.metadata?.kind === 'assistant-reply');
    const find = (re) => replies.find((m) => re.test(String(m.message)));
    for (const [form, re, who] of [['the name at the end of the sentence', /lisbon/i, 'u-vera'], ['"Hey Nova"', /four/i, 'u-nora'], ['"Nova?" then a two second pause then the question', /madrid/i, 'u-mia']]) {
      const m = find(re);
      r.expect(`${form}: answered, labelled with who spoke`, !!m && m.metadata.askedBy === who, m ? `labelled ${m.metadata.askedBy}` : 'no reply');
    }
    r.measure('requests counted after the three addressed forms', s4a?.counters?.requests ?? -1);
    r.expect('"Nora, what do you think?" raised no request and was not answered', s4b?.counters?.requests === s4a?.counters?.requests && replies.length === 3, `requests ${s4a?.counters?.requests} -> ${s4b?.counters?.requests}, ${replies.length} replies`);
    r.expect('talk about Nova in the third person raised no request and was not answered', s5?.counters?.requests === s4b?.counters?.requests && replies.length === 3, `requests ${s4b?.counters?.requests} -> ${s5?.counters?.requests}, ${replies.length} replies`);
    r.measure('requests counted at the end', s5?.counters?.requests ?? -1);
    void [f1, f2, f3a, f3b];
  },
};
