// crosstalk: three people talk over each other the way a real call does: pairs overlapping by a third to a half of a line, short
// interjections under a long line, and an addressed request spoken while someone else is still talking. Attribution is measured for
// every line (right, wrong, missing, split between two people); the asker of the request must be the person who spoke it.
import { synth, msOf, PEOPLE } from '../lib/harness.mjs';

export default {
  order: 5, id: 'crosstalk', limitSeconds: 120, title: 'overlapping speech: attribution per line, and the request\'s asker is its speaker',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'] });
    for (const k of ['vera', 'nora', 'mia']) ctx.lane(k);
    const lines = [];
    const dur = (key, text) => msOf(synth(text, { voice: PEOPLE[key].voice, dir: ctx.world.dir }).pcm);
    // Place a line so that it starts `overlap` (a fraction of its own length) before `prev` ends; or `offset` ms into `prev`.
    const place = (key, text, { prev = null, overlap = 0, inside = null, gap = 1500, dry } = {}) => {
      const d = dur(key, text);
      const at = prev ? (inside !== null ? prev.atMs + inside : prev.endMs - Math.round(overlap * d)) : ctx.cursor + gap;
      const ev = ctx.say(key, Math.max(0, at), text, { dry });
      lines.push({ key, text, ev });
      ctx.cursor = Math.max(ctx.cursor, ev.endMs);
      return ev;
    };
    ctx.at(600);
    // Pairs overlapping by a third to a half of the later line.
    const a1 = place('vera', 'I want to walk through the plan for the scheduling app launch, starting with the sign in changes and then the reminder emails.');
    const a2 = place('nora', 'Right, and the reminder emails need a clear unsubscribe link before we send any of them.', { prev: a1, overlap: 0.4 });
    const b1 = place('mia', 'The calendar sync is the part that worries me, because the time zones are still wrong for some people.', { gap: 2500 });
    const b2 = place('vera', 'We can test it with the three accounts from the support queue this afternoon.', { prev: b1, overlap: 0.34 });
    const b3 = place('nora', 'I can write up the steps so anyone on the team can repeat the test.', { prev: b2, overlap: 0.5 });
    // Short interjections under a long line.
    const c1 = place('vera', 'What I would like is for every reminder to say clearly what it is about, who sent it, and how to turn it off, and then we can decide whether the digest needs the same treatment next week.', { gap: 2800 });
    place('nora', 'Right.', { prev: c1, inside: 2500 });
    place('mia', 'Agreed.', { prev: c1, inside: 5500 });
    // A request while someone else is still talking.
    const d1 = place('vera', 'While we are on the launch, I also checked the release notes from last week and they still mention the old sign in page, so those need a pass before anything goes out to customers.', { gap: 2800 });
    const req = place('mia', 'Nova, what is two plus two?', { prev: d1, inside: 3500, dry: { reply: { text: 'Two plus two is four.', frames: 12 } } });
    ctx.begin();
    await ctx.until(Math.max(d1.endMs, req.endMs) + 9000);
    await ctx.world.stopLanes();
    await ctx.debug();

    const stored = await call.transcript();
    let right = 0, wrong = 0, missing = 0, split = 0;
    const detail = [];
    for (const l of lines) {
      const hit = stored.filter((s) => s.text.trim() === l.text);
      let verdict;
      if (!hit.length) { missing += 1; verdict = 'missing'; }
      else if (hit.some((s) => (s.speakers?.length ?? 0) > 1)) { split += 1; verdict = 'split'; }
      else if (hit.every((s) => s.userId === `u-${l.key}`)) { right += 1; verdict = 'right'; }
      else { wrong += 1; verdict = 'wrong'; }
      detail.push(`${l.key}:${verdict}`);
    }
    r.measure('lines', lines.length);
    r.measure('right', right); r.measure('wrong', wrong); r.measure('missing', missing); r.measure('split between two people', split);
    r.note(detail.join(' '));
    const chat = await call.chatMessages(p.vera);
    const answer = chat.find((m) => m.metadata?.kind === 'assistant-reply' && /four/i.test(String(m.message)));
    r.expect('the request spoken over Vera is answered, labelled with Mia who spoke it', !!answer && answer.metadata.askedBy === 'u-mia', answer ? `labelled ${answer.metadata.askedBy}` : 'no reply (the asker could not be told)');
    r.harness('every planned line reached the provider as a transcript', stored.length >= lines.length - 2, `${stored.length} stored of ${lines.length}`);
  },
};
