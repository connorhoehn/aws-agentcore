// provider-drop: the connection to the provider is cut mid-call (in --dry the fake provider's socket; in a paid run the pass-through
// proxy's tunnel, which forwards to the real provider and is cut by destroying both sockets).
// What the plan promises (docs/meeting-assistant-design.md decision 11; orchestrator.ts onClosed/reopen/giveUp): an unexpected close is
// answered by a replacement session started with the last minutes of the call as context (up to three, retried after 1, 3 and 9 seconds),
// and only when none can be opened does Nova leave with a notice. Checked here: Nova is still listening afterwards and said nothing
// about leaving; the new session knows what was said before the drop (dry only: the paid run cannot see the session's instructions);
// the dead session is hung up and not billed past its death; a request after the recovery is answered, labelled with its asker.
import { sleep, waitFor } from '../lib/harness.mjs';

export default {
  order: 12, id: 'provider-drop', proxy: true, limitSeconds: 120, title: 'a cut provider connection is replaced; billing stops with the dead session',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'] });
    for (const k of ['vera', 'nora', 'mia']) ctx.lane(k);
    const before = 'The launch checklist has three items left, and the first is the reminder wording.';
    ctx.say('vera', 800, before);
    const ask = ctx.say('nora', 24_000, 'Nova, what is two plus two?', { dry: { reply: { text: 'Two plus two is four.', frames: 12 } } });
    ctx.begin();
    await ctx.until(9000);
    const startsBefore = ctx.world.provider?.seen.started ?? null;
    const cutAt = Date.now();
    ctx.world.cutProvider();
    r.harness('the provider connection was cut', true, ctx.dry ? 'fake provider sockets terminated' : 'proxy tunnel destroyed');
    let recoveredAt = null;
    if (ctx.dry) {
      const ok = await waitFor(() => ctx.world.provider.seen.started > startsBefore, 20_000, 200);
      recoveredAt = ok ? Date.now() : null;
      r.expect('a replacement session was opened after the drop', !!ok, `${ctx.world.provider.seen.started} session(s) started, outage ${recoveredAt ? recoveredAt - cutAt : '>20000'} ms`);
      const text = ctx.world.provider.seen.instructions[1] ?? '';
      r.expect('the replacement was given the call so far (a line spoken before the drop)', /three items left|reminder wording/i.test(text), text ? `${text.length} characters of instructions` : 'no second start');
      r.measure('seconds from the cut to the replacement', recoveredAt ? (recoveredAt - cutAt) / 1000 : -1);
      r.measure('hang-up requests the dead session received', ctx.world.provider.seen.hangups);
    } else {
      await sleep(8000);
    }
    const mid = await call.state();
    r.expect('Nova is still listening after the drop', mid?.state === 'listening', `state ${mid?.state}`);
    const noticeBad = (await call.novaMessages(p.vera)).find((m) => /lost its connection|has left/i.test(String(m.message)));
    r.expect('no "lost its connection" notice was posted', !noticeBad, noticeBad ? String(noticeBad.message).slice(0, 80) : '');
    r.measure('provider errors counted', mid?.providerErrors ?? -1);
    await ctx.until(ask.endMs + 9000);
    await ctx.world.stopLanes();
    await ctx.debug();
    const chat = await call.chatMessages(p.vera);
    const answer = chat.find((m) => m.metadata?.kind === 'assistant-reply' && /four/i.test(String(m.message)));
    if (ctx.dry) r.expect('a request after the recovery is answered, labelled with Nora', !!answer && answer.metadata.askedBy === 'u-nora', answer ? `labelled ${answer.metadata.askedBy}` : 'no reply');
    else r.expect('a request after the recovery is answered, labelled with Nora (the real model decides; the line must at least be stored under Nora)', (await call.transcript()).some((l) => l.userId === 'u-nora' && /two plus two/i.test(l.text)), answer ? `reply labelled ${answer.metadata.askedBy}` : 'no reply posted');
    const line = (await call.transcript()).find((l) => /three items left|reminder wording/i.test(l.text));
    r.expect('the line spoken before the drop is stored under Vera', !!line && line.userId === 'u-vera', line ? line.userId : 'not stored');
    // Billing: dismiss now and compare what was billed with the wall time, less the time with no session.
    const wallSeconds = Math.round((Date.now() - call.invitedAt) / 1000);
    const d = await call.dismiss();
    r.harness('Vera dismisses Nova', d.status === 200, `HTTP ${d.status}`);
    const { billingOf } = await import('../lib/harness.mjs');
    const bill = await billingOf(p.vera, call);
    const outage = recoveredAt ? Math.round((recoveredAt - cutAt) / 1000) : 0;
    r.measure('billed seconds', bill.ledgerSeconds ?? 'no entry');
    r.measure('wall seconds since the invite', wallSeconds);
    r.measure('seconds with no session', outage);
    r.expect('billing did not run on past the dead session (billed <= wall seconds less the outage, plus 4)', bill.ledgerSeconds !== null && bill.ledgerSeconds <= wallSeconds - outage + 4, `billed ${bill.ledgerSeconds}, wall ${wallSeconds}, outage ${outage}`);
  },
};
