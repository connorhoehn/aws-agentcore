// pause-resume-dismiss: Nova's whole life cycle in one call.
//  talk -> pause -> a request during the pause is neither stored nor answered, and no audio reaches the provider (judged from the sink's
//  own counters and answers, and from the fake provider's frame count in --dry) -> resume -> the same request is answered ->
//  dismiss -> a chunk after the dismissal is a 404 -> the spend is settled and billed seconds are compared with listening and wall time.
import { sleep } from '../lib/harness.mjs';

export default {
  order: 10, id: 'pause-resume-dismiss', limitSeconds: 120, title: 'a pause hears nothing and bills nothing; resume answers; dismiss kills the sink and settles',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'] });
    for (const k of ['vera', 'nora', 'mia']) ctx.lane(k);
    const q = 'Nova, what is two plus two?';
    ctx.say('vera', 500, 'We should finalise the launch checklist today.');
    const during = ctx.say('nora', 9000, q, { dry: { reply: { text: 'Two plus two is four.', frames: 12 } } });
    const after = ctx.say('nora', 27_000, q, { dry: { reply: { text: 'Two plus two is four.', frames: 12 } } });
    ctx.begin();
    const wallStart = Date.now();
    await ctx.until(5500);
    const framesBefore = ctx.world.provider?.seen.frames ?? null;
    const pausedAt = Date.now();
    const pause = await p.vera.call('POST', `${call.A}/pause`);
    r.harness('Vera pauses Nova', pause.status === 200 && pause.json?.state === 'paused', `HTTP ${pause.status}, ${pause.json?.state}`);
    await ctx.until(during.endMs + 4000);
    const stPaused = await call.state();
    const audioPaused = await call.audio();
    const linesPaused = await call.transcript();
    const chatPaused = await call.chatMessages(p.vera);
    const framesAtPause = ctx.world.provider?.seen.frames ?? null;
    r.expect('the request during the pause was not stored', !linesPaused.some((l) => /two plus two/i.test(l.text)), `${linesPaused.length} line(s) stored`);
    r.expect('the request during the pause was not answered', !chatPaused.some((m) => m.metadata?.kind === 'assistant-reply'));
    const lane = ctx.lanes.nora;
    r.expect('the sink refused the audio during the pause (a dead token answers 404)', (lane.answers['404'] ?? 0) > 0, `answers ${JSON.stringify(lane.answers)}; counters ${JSON.stringify(audioPaused?.counters ?? null)}`);
    if (framesBefore !== null) r.expect('no audio reached the provider during the pause', framesAtPause - framesBefore <= 12, `${framesAtPause - framesBefore} frames between the pause and ${Math.round((Date.now() - pausedAt) / 1000)} s later (a few can be in flight)`);
    r.measure('listening seconds frozen at the pause', stPaused?.listeningSeconds ?? -1);
    // Resume: a fresh sink, as the media server is told again.
    await ctx.until(15_000);
    const resumedAt = Date.now();
    const resume = await p.vera.call('POST', `${call.A}/resume`);
    r.harness('Vera resumes Nova', resume.status === 200 && resume.json?.state === 'listening', `HTTP ${resume.status}, ${resume.json?.state}`);
    const oldToken = call.sink.token;
    await call.discoverSink();
    r.harness('the resumed call has a fresh sink token', call.sink.token !== oldToken);
    for (const l of Object.values(ctx.lanes)) l.sink = call.sink;
    const pausedMs = resumedAt - pausedAt;
    await ctx.until(after.endMs + 9000);
    await ctx.world.stopLanes();
    await ctx.debug();
    const chat = await call.chatMessages(p.vera);
    const answer = chat.find((m) => m.metadata?.kind === 'assistant-reply' && /four/i.test(String(m.message)));
    r.expect('after the resume the same request is answered, labelled with Nora', !!answer && answer.metadata.askedBy === 'u-nora', answer ? `labelled ${answer.metadata.askedBy}` : 'no reply');
    const listeningBefore = (await call.state())?.listeningSeconds ?? 0;
    const lastToken = call.sink.token;
    const dismiss = await call.dismiss();
    r.harness('Vera dismisses Nova', dismiss.status === 200 && dismiss.json?.state === 'left', `HTTP ${dismiss.status}`);
    await sleep(500);
    const post = await fetch(`${ctx.world.base}/api/internal/meeting-assistant/pcm/${encodeURIComponent(lastToken)}`, {
      method: 'POST', body: Buffer.alloc(6400),
      headers: { 'Content-Type': 'application/octet-stream', 'X-Tap-Id': 'tap-sim', 'X-Channel-Arn': call.sink.channelArn, 'X-Participant-Id': call.participantIds['u-nora'], 'X-Producer-Id': 'producer-late', 'X-Sample-Rate': '16000', 'X-Encoding': 'pcm_s16le', 'X-Channels': '1', ...(ctx.dry ? { 'X-Live-Captions-Secret': 'dry-sink-secret' } : {}) },
    });
    r.expect('a chunk after the dismissal gets 404', post.status === 404, `HTTP ${post.status}`);
    const state = await call.state();
    r.expect('the call is left and its spend is settled', state?.state === 'left', `state ${state?.state}`);
    const { billingOf } = await import('../lib/harness.mjs');
    const bill = await billingOf(p.vera, call);
    const wallSeconds = Math.round((Date.now() - wallStart) / 1000);
    r.measure('billed seconds (ledger)', bill.ledgerSeconds ?? 'no entry');
    r.measure('listening seconds (state)', state?.listeningSeconds ?? -1);
    r.measure('wall seconds since the clock started', wallSeconds);
    r.measure('paused seconds', Math.round(pausedMs / 1000));
    r.expect('billed seconds are close to the listening seconds', bill.ledgerSeconds !== null && Math.abs(bill.ledgerSeconds - (state?.listeningSeconds ?? 0)) <= 4, `billed ${bill.ledgerSeconds}, listening ${state?.listeningSeconds}`);
    r.expect('billed seconds leave out the paused time', bill.ledgerSeconds !== null && bill.ledgerSeconds <= wallSeconds - Math.round(pausedMs / 1000) + 3, `billed ${bill.ledgerSeconds} <= wall ${wallSeconds} - paused ${Math.round(pausedMs / 1000)}`);
    void listeningBefore;
  },
};
