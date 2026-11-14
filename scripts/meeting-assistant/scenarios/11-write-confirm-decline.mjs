// write-confirm-decline: a write goes through a card the asker decides.
//  Vera asks for a work item, gets the card, confirms; her browser claims the turn and posts success; Nova's follow-up is labelled Vera.
//  Nora asks for one and declines the card: no turn runs.
//  The refusal of a person whose role may not create one: every OrgIQ role in the mock world holds the create tool (checked from the
//  catalogue), so that case cannot be staged with the mock people; it is reported as a note, not a check.
import { waitFor, sleep } from '../lib/harness.mjs';

export default {
  order: 11, id: 'write-confirm-decline', limitSeconds: 120, title: 'confirm runs the write for its asker; decline runs nothing',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'] });
    for (const k of ['vera', 'nora', 'mia']) ctx.lane(k);
    const create = (title, who) => ({ call: { name: 'create', args: { kind: 'work-item', fields: { title } } }, followup: `I have asked ${who} to confirm that.`, afterContext: (c) => ({ text: /was done/i.test(c) ? `I created the work item for ${who}.` : `Understood, ${who} said no.`, frames: 12 }) });
    ctx.say('vera', 1000, 'Nova, create a work item for the calendar sync bug.', { dry: create('Calendar sync bug', 'Vera') });
    const noraAt = 26_000;
    ctx.say('nora', noraAt, 'Nova, create a work item for the login cookie bug.', { dry: create('Login cookie bug', 'Nora') });
    const veraRuns = ctx.turns('vera', (t) => (t.kind === 'write' ? { ok: true, say: 'Created the work item.', delayMs: 300 } : { withhold: true }));
    const noraRuns = ctx.turns('nora', () => ({ ok: true, say: 'Created the work item.' }));
    ctx.begin();
    const cardOf = (title, who) => waitFor(async () => (await call.novaMessages(p.vera)).find((m) => m.metadata?.kind === 'assistant-action' && m.metadata?.askedBy === who && new RegExp(title, "i").test(String(m.message ?? ""))), 25_000, 400);
    // Vera
    const c1 = await cardOf('calendar sync', 'u-vera');
    r.expect('Vera\'s request is a card waiting for Vera', !!c1 && c1.metadata.status === 'waiting', c1 ? `${c1.metadata.status}: ${c1.metadata.summary}` : 'no card');
    if (c1) {
      const other = await p.nora.call('POST', `${call.A}/actions/${encodeURIComponent(c1.metadata.actionId)}/decision`, { decision: 'confirm' });
      r.expect('only the asker can decide the card (Nora is refused)', other.status === 403, `HTTP ${other.status}`);
      const ok = await p.vera.call('POST', `${call.A}/actions/${encodeURIComponent(c1.metadata.actionId)}/decision`, { decision: 'confirm' });
      r.harness('Vera confirms the card', ok.status === 200, `HTTP ${ok.status}`);
      const done = await waitFor(async () => { const m = (await call.novaMessages(p.vera)).find((x) => x.metadata?.actionId === c1.metadata.actionId); return m?.metadata?.status === 'done' ? m : null; }, 15_000, 400);
      r.expect('the stand-in ran Vera\'s write once and the card says done', !!done && veraRuns.log.filter((x) => x.kind === 'write' && x.posted === 200).length === 1, `${done?.metadata?.status ?? 'not done'}; ${veraRuns.log.length} turn(s)`);
    }
    await sleep(3500);
    const chat1 = await call.chatMessages(p.vera);
    const follow = chat1.find((m) => m.metadata?.kind === 'assistant-reply' && /created the work item for vera/i.test(String(m.message)));
    r.expect('Nova\'s follow-up after the write is posted and labelled Vera', !!follow && follow.metadata.askedBy === 'u-vera', follow ? `labelled ${follow.metadata.askedBy}` : 'no follow-up');
    // Nora
    await ctx.until(noraAt);
    const c2 = await cardOf('login cookie', 'u-nora');
    r.expect('Nora\'s request is a card waiting for Nora', !!c2 && c2.metadata.status === 'waiting', c2 ? `${c2.metadata.status}` : 'no card');
    if (c2) {
      const no = await p.nora.call('POST', `${call.A}/actions/${encodeURIComponent(c2.metadata.actionId)}/decision`, { decision: 'decline' });
      r.harness('Nora declines the card', no.status === 200, `HTTP ${no.status}`);
      await sleep(4000);
      const after = (await call.novaMessages(p.vera)).find((m) => m.metadata?.actionId === c2.metadata.actionId);
      r.expect('the declined card says declined', after?.metadata?.status === 'declined', `status ${after?.metadata?.status}`);
      r.expect('no turn ran for the declined write', noraRuns.log.length === 0, `${noraRuns.log.length} turn(s) on Nora's stand-in`);
    }
    const chat2 = await call.chatMessages(p.vera);
    r.expect('nothing was posted as done for Nora', !chat2.some((m) => /created the work item for nora/i.test(String(m.message))));
    r.note('role refusal not staged: every OrgIQ role in the mock world holds the create tool (meetingTools), so no mock person can be refused');
    await ctx.until(noraAt + 12_000);
    await ctx.world.stopLanes();
    await ctx.debug();
    const state = await call.state();
    r.measure('refused calls', state?.refusedCalls ?? -1);
  },
};
