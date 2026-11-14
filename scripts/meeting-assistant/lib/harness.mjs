// The shared pieces of the meeting-assistant scripts (live-e2e.mjs and scenarios.mjs), in one import.
//   safety.mjs  the guard, the budget, the signal handlers
//   audio.mjs   speech, noise, the real-time lane
//   fakes.mjs   the fake provider and media server, the pass-through proxy
//   world.mjs   the middleware child, people, calls, the check classes
// plus the helpers a scenario's body uses (`setup`, `waitFor`, `until`).
import { PEOPLE, Call, World, Reporter, sleep, billingOf } from './world.mjs';
import { synth, msOf, concat, silence, gained, resample, pcmFromBase64 } from './audio.mjs';

export * from './safety.mjs';
export * from './audio.mjs';
export * from './fakes.mjs';
export * from './world.mjs';

/** Poll `fn` until it returns something truthy, or `ms` have passed (null then). */
export async function waitFor(fn, ms = 15_000, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(step);
  }
}

/**
 * What a scenario's body gets as `ctx`: the world, the check classes, and helpers that bind them.
 *   ctx.setup({ people: ['vera','nora'], inviter, ack, voice, late })  seat people, invite Nova, bind, acknowledge, find the sink;
 *                                                                      returns { p: { vera, ... }, call }
 *   ctx.say(key, atMs, text, { gain, rate, dry, voice })              place an utterance on that person's lane (made on first use)
 *   ctx.until(ms)                                                      wait for the scenario clock
 *   ctx.run(ms)                                                        start the clock and lanes; wait until `ms`, then stop the lanes
 */
export function makeContext({ world, reporter, minutes = null, dry }) {
  const ctx = { world, dry, minutes, r: reporter, harness: reporter.harness, expect: reporter.expect, measure: reporter.measure, note: reporter.note, call: null, p: {}, lanes: {}, runners: [] };
  ctx.setup = async ({ people, inviter = people[0], ack, voice = false, late = [] }) => {
    const present = people.filter((k) => !late.includes(k));
    for (const k of people) ctx.p[k] = await world.person(PEOPLE[k]);
    const others = present.filter((k) => k !== inviter).map((k) => ctx.p[k]);
    ctx.call = await Call.start(world, { inviter: ctx.p[inviter], others, ack: ack ? ack.map((k) => ctx.p[k]) : others, voice });
    ctx.inviterKey = inviter;
    return { p: ctx.p, call: ctx.call };
  };
  ctx.lane = (key, opts = {}) => (ctx.lanes[key] ??= world.lane(ctx.p[key], ctx.call, opts));
  ctx.say = (key, atMs, text, { gain = 1, rate, dry: dryBehaviour = null, voice, label = '' } = {}) => {
    const lane = ctx.lane(key);
    const { pcm } = synth(text, { voice: voice ?? PEOPLE[key].voice, rate, dir: world.dir });
    return lane.say(atMs, pcm, { gain, dry: dryBehaviour, text, label });
  };
  /** A cursor for laying a dialogue out one line after another: `next` places the line `gap` ms after the previous one ended (a negative gap overlaps). */
  ctx.cursor = 0;
  ctx.at = (ms) => { ctx.cursor = ms; return ctx; };
  ctx.next = (key, text, { gap = 1200, ...opts } = {}) => { const ev = ctx.say(key, ctx.cursor + gap, text, opts); ctx.cursor = ev.endMs; return ev; };
  ctx.until = async (ms) => { const wait = ms - world.clock.now(); if (wait > 0) await sleep(wait); };
  ctx.begin = () => { world.startClock(); for (const lane of Object.values(ctx.lanes)) lane.start(); };
  ctx.run = async (ms) => { ctx.begin(); await ctx.until(ms); await world.stopLanes(); };
  ctx.turns = (key, decide) => { const t = ctx.p[key].runTurns(ctx.call.callId, decide); ctx.runners.push(t); return t; };
  ctx.debug = async () => { if (!process.env.MA_DEBUG) return; const raw = await ctx.p[ctx.inviterKey].call('GET', `/api/calls/${encodeURIComponent(ctx.call.callId)}/chat?limit=100`); console.log(`     [debug] chat http ${raw.status} ${JSON.stringify(raw.json)?.slice(0, 300)}`); const m = raw.json?.messages ?? []; for (const x of m) console.log(`     [debug] chat ${x.userId} ${x.metadata?.kind ?? ''} ${String(x.message).slice(0, 110)}`); const tl = await ctx.call.transcript(); for (const l of tl) console.log(`     [debug] line ${l.userId} ${JSON.stringify(l.speakers ?? [])} ${l.startMs}-${l.endMs} at=${l.at} ${l.text.slice(0, 60)}`); console.log(`     [debug] provider ${JSON.stringify(world.provider?.seen)}`); const st = await ctx.call.state(); console.log(`     [debug] state ${JSON.stringify(st)}`); };
  ctx.novaMessages = () => ctx.call.novaMessages(ctx.p[ctx.inviterKey]);
  return ctx;
}

/**
 * A laptop speaker: every `assistant-audio` frame `person` receives is resampled to 16 kHz, attenuated by `gainDb`, delayed by `delayMs`
 * and mixed into `lane`, contiguously (frames arriving in a burst are laid end to end). Held in memory only; nothing is written.
 */
export function attachEcho({ clock, person, lane, delayMs, gainDb = -12 }) {
  const ctl = { frames: 0, nextAt: 0, lastEndMs: 0, firstAtMs: null, lastSeen: false };
  const g = 10 ** (gainDb / 20);
  person.audioHook = (data) => {
    const pcm = gained(resample(pcmFromBase64(data?.pcm), data?.sampleRate ?? 24_000, 16_000), g);
    const now = clock.now();
    const at = Math.max(now + delayMs, ctl.nextAt);
    lane.inject(pcm, at - now);
    ctl.frames += 1; ctl.nextAt = at + msOf(pcm); ctl.lastEndMs = ctl.nextAt; ctl.firstAtMs ??= at; ctl.lastSeen = data?.last === true;
  };
  ctl.detach = () => { person.audioHook = null; };
  return ctl;
}

export { PEOPLE, Call, World, Reporter, sleep, billingOf, synth, msOf, concat, silence };
