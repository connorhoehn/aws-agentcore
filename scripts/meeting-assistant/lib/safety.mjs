// The safety shared by every meeting-assistant script that can spend money (live-e2e.mjs and scenarios.mjs).
//
//  * A `Guard` knows the middleware child, the temp folder and how to dismiss Nova. Every way out (normal end, SIGINT, SIGTERM, an
//    uncaught error, a rejected promise, a scenario's hard stop) goes through `guard.shutdown()`: dismiss with a 3 second time box,
//    then SIGTERM the child (SIGKILL after 2 seconds), then remove the temp folder. Dismissal is reported from the real answer.
//  * The child also carries two limits of its own, so it ends the session by itself even if this process is gone:
//    MEETING_ASSISTANT_MAX_MINUTES (the server leaves at the ceiling) and the dead-man preload (lib/deadman.cjs).
//  * Cost: the provider bills $0.05 a minute of listening; a scenario's worst case is its limit plus a few cents of tool tokens.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRICE_PER_MINUTE = 0.05;
export const TOOL_ALLOWANCE_USD = 0.02;
export const BUDGET_DEFAULT_USD = 1;
export const BUDGET_MAX_USD = 10;
export const DEADMAN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'deadman.cjs');

/** The most a call of `limitSeconds` can cost: listening time at the provider's rate plus an allowance for tool-call tokens. */
export const worstCaseUsd = (limitSeconds) => (limitSeconds / 60) * PRICE_PER_MINUTE + TOOL_ALLOWANCE_USD;

/** The server's own ceiling for a scenario: its limit plus one minute (a fraction of a minute is fine: limits.ts rounds the seconds). */
export const maxMinutesFor = (limitSeconds) => limitSeconds / 60 + 1;

/** How long the child may live before the dead-man preload ends it: boot, the limit, and a margin for the clean-up. */
export const deadmanMsFor = (limitSeconds) => (limitSeconds + 150) * 1000;

/** Parse and bound --budget-usd. Returns a number, or throws a plain message (refused above the maximum). */
export function parseBudget(raw) {
  if (raw === undefined) return BUDGET_DEFAULT_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--budget-usd needs a positive number, got "${raw}"`);
  if (n > BUDGET_MAX_USD) throw new Error(`--budget-usd ${n} is refused: the most this runner allows is ${BUDGET_MAX_USD}`);
  return n;
}

/** Running total of what paid scenarios were allowed and what they cost. */
export class Budget {
  constructor(limitUsd) { this.limitUsd = limitUsd; this.spentUsd = 0; }
  /** True when a scenario of this limit may start: the running total plus its worst case stays within the budget. */
  allows(limitSeconds) { return this.spentUsd + worstCaseUsd(limitSeconds) <= this.limitUsd + 1e-9; }
  /** Add what a finished scenario cost: the call's own billed seconds when known, else the wall-clock worst case. */
  add({ billedSeconds, wallSeconds, limitSeconds }) {
    const seconds = Number.isFinite(billedSeconds) ? billedSeconds : Math.min(Number.isFinite(wallSeconds) ? wallSeconds : limitSeconds, limitSeconds + 60);
    const usd = (seconds / 60) * PRICE_PER_MINUTE + (Number.isFinite(billedSeconds) ? 0 : TOOL_ALLOWANCE_USD);
    this.spentUsd += usd;
    return { seconds, usd, estimated: !Number.isFinite(billedSeconds) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)]);

export class Guard {
  constructor({ dir, keep = false, say = (m) => console.log(m) }) {
    this.dir = dir; this.keep = keep; this.say = say;
    this.child = null;
    this.dismissFn = null;      // async () => { status, state }  (the real answer of the dismiss call)
    this.closers = [];          // async () => void: fake servers, sockets
    this.done = null;           // promise of the shutdown in progress
    this.dismissReport = null;
  }
  attachChild(child) { this.child = child; }
  onDismiss(fn) { this.dismissFn = fn; }
  onClose(fn) { this.closers.push(fn); }

  /** Dismiss with a 3 second time box. The report comes from the answer; nothing is assumed. */
  async dismiss() {
    if (!this.dismissFn) return { attempted: false };
    const fn = this.dismissFn; this.dismissFn = null;
    const answer = await withTimeout(Promise.resolve().then(fn).catch((e) => ({ error: String(e?.message ?? e).slice(0, 80) })), 3000, { timedOut: true });
    this.dismissReport = { attempted: true, ...answer };
    this.say(`dismiss: ${answer?.timedOut ? 'no answer within 3 s' : answer?.error ? `failed (${answer.error})` : `HTTP ${answer?.status}, state ${answer?.state ?? 'unknown'}`}`);
    return this.dismissReport;
  }

  async killChild() {
    const child = this.child; this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r));
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    const ok = await withTimeout(exited.then(() => true), 2000, false);
    if (!ok) { try { child.kill('SIGKILL'); } catch { /* gone */ } await withTimeout(exited, 2000, null); }
  }

  /** The one way out: dismiss, kill the child, close the fakes, remove the folder. Safe to call twice. */
  shutdown() {
    this.done ??= (async () => {
      await this.dismiss();
      await this.killChild();
      for (const close of this.closers.splice(0)) { try { await withTimeout(Promise.resolve().then(close), 2000, null); } catch { /* best effort */ } }
      if (!this.keep) { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    })();
    return this.done;
  }
}

let installed = null;
/**
 * SIGINT, SIGTERM, uncaughtException and unhandledRejection all go through the live guard (`getGuard()`), then exit 1.
 * Installed once per process; `getGuard` returns whichever guard is current (a scenario run has one at a time).
 */
export function installSafetyHandlers(getGuard, say = (m) => console.log(m)) {
  if (installed) return;
  installed = true;
  let going = false;
  const bail = (why) => {
    if (going) return;
    going = true;
    say(`safety: ${why}; dismissing and stopping what this run started`);
    const guard = getGuard();
    const finish = () => process.exit(1);
    if (!guard) { finish(); return; }
    guard.shutdown().then(finish, finish);
    setTimeout(finish, 12_000).unref?.();
  };
  process.on('SIGINT', () => bail('interrupted'));
  process.on('SIGTERM', () => bail('terminated'));
  process.on('uncaughtException', (e) => bail(`uncaught error (${String(e?.message ?? e).slice(0, 80)})`));
  process.on('unhandledRejection', (e) => bail(`unhandled rejection (${String(e?.message ?? e).slice(0, 80)})`));
}

/** Print the plan and the cost, as the runner does without --yes. */
export function printPlan(items, { budget }) {
  let total = 0;
  console.log('PAID PLAN (nothing was started):');
  for (const it of items) { const c = worstCaseUsd(it.limitSeconds); total += c; console.log(`  ${it.id.padEnd(22)} limit ${String(it.limitSeconds).padStart(4)} s   worst case $${c.toFixed(2)}`); }
  console.log(`  total worst case $${total.toFixed(2)}; budget $${budget.toFixed(2)}${total > budget ? ' (some scenarios would be refused)' : ''}`);
  console.log('Re-run with --yes to spend it, or with --dry to run against the fake provider at no cost.');
}
