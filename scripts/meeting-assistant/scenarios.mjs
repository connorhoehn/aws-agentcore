#!/usr/bin/env node
// The meeting assistant's scenario suite: scripted calls of a fictional product team, each judged on what Nova does and does not do.
// docs/meeting-assistant-design.md is the plan; scenarios/*.mjs are the calls, one file each.
//
//   node scripts/meeting-assistant/scenarios.mjs --list
//   node scripts/meeting-assistant/scenarios.mjs --scenario all --dry            NO PROVIDER, NO COST: a fake provider scripted per scenario
//   node scripts/meeting-assistant/scenarios.mjs --scenario private-read --yes   THE PAID RUN of one scenario (real provider)
//   options: --scenario <id>[,<id>...]|all   --budget-usd <n> (default 1, at most 10)   --port-base <n> (default 3953)
//            --minutes <n> (the long scenario's length)   --out <file> (JSON summary)   --keep-logs
//
// Three kinds of check are printed, one line each:
//   [harness]  plumbing that must hold (a failure means the harness is wrong)
//   [expect]   behaviour the product must have (a failure is a FINDING about the product)
//   [measure]  numbers only
// The run ends with a table per scenario and a FINDINGS list; it exits 1 if any harness or expect check failed.
//
// Safety (lib/safety.mjs): paid mode needs --yes (without it the plan and the worst-case cost are printed and nothing starts); every
// scenario runs in a fresh middleware that ends the session by itself a minute after the scenario's limit and carries a dead-man
// preload; SIGINT, SIGTERM and any uncaught error dismiss Nova (3 s time box), stop the middleware and remove the temp folder.
// Audio is synthetic speech in a temp folder removed on every exit path; no key, token or header is printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Reporter, World, portsFor, makeContext, billingOf, Budget, parseBudget, printPlan, worstCaseUsd, installSafetyHandlers, tailLog, sleep, hasSay,
} from './lib/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(name);

async function loadScenarios() {
  const dir = path.join(HERE, 'scenarios');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const all = [];
  for (const f of files) all.push((await import(pathToFileURL(path.join(dir, f)).href)).default);
  return all.sort((a, b) => a.order - b.order);
}

const scenarios = await loadScenarios();
const minutesFlag = flag('--minutes') !== undefined ? Number(flag('--minutes')) : null;
const limitOf = (s) => (typeof s.limitSeconds === 'function' ? s.limitSeconds({ minutes: minutesFlag }) : s.limitSeconds);

if (has('--list')) {
  for (const s of scenarios) console.log(`${s.id.padEnd(22)} limit ${String(limitOf(s)).padStart(4)} s  ${s.title}`);
  process.exit(0);
}

const DRY = has('--dry'), YES = has('--yes');
let budget;
try { budget = parseBudget(flag('--budget-usd')); } catch (e) { console.error(`scenarios: ${e.message}`); process.exit(2); }
const pick = flag('--scenario');
if (!pick) { console.error('scenarios: say which with --scenario <id>[,<id>...] or --scenario all (or --list)'); process.exit(2); }
const chosen = pick === 'all' ? scenarios : pick.split(',').map((id) => scenarios.find((s) => s.id === id.trim()) ?? null);
if (chosen.some((s) => !s)) { console.error(`scenarios: unknown scenario in "${pick}"; --list shows them`); process.exit(2); }
if (!DRY && !YES) { printPlan(chosen.map((s) => ({ id: s.id, limitSeconds: limitOf(s) })), { budget }); process.exit(2); }
const portBase = flag('--port-base') !== undefined ? Number(flag('--port-base')) : 3953;
if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65_000) { console.error('scenarios: --port-base needs a port number'); process.exit(2); }
const ports = portsFor(portBase);

if (!DRY) {
  // The key is read by the middleware itself from its env file; this only checks that it is there, without reading it out.
  const envFile = path.resolve(HERE, '..', '..', 'middleware', '.env');
  let present = false;
  try { const t = fs.readFileSync(envFile, 'utf8'); present = /^OPENAI_API_KEY=\S/m.test(t) && !/^OPENAI_API_KEY=.*REPLACE_ME/m.test(t); } catch { present = false; }
  if (!present) { console.error('scenarios: the middleware env file has no OPENAI_API_KEY; nothing was started and nothing was spent'); process.exit(2); }
}

const reporter = new Reporter();
const budgetState = new Budget(budget);
let currentGuard = null;
installSafetyHandlers(() => currentGuard);
const summary = { mode: DRY ? 'dry' : 'paid', budgetUsd: budget, scenarios: [] };

console.log(`scenarios: ${DRY ? 'DRY RUN (fake provider, no cost)' : 'PAID RUN (real provider sessions)'}; ${chosen.length} scenario(s); ports ${ports.mw}-${ports.spare}; speech: ${hasSay ? 'say' : 'tones'}`);

for (const s of chosen) {
  const limitSeconds = limitOf(s);
  reporter.begin(s.id);
  const entry = { id: s.id, limitSeconds, billedSeconds: null, costUsd: 0, estimatedCost: false, wallSeconds: 0, skipped: false };
  summary.scenarios.push(entry);
  if (!DRY && !budgetState.allows(limitSeconds)) {
    reporter.harness('the budget allows this scenario', false, `running total $${budgetState.spentUsd.toFixed(2)} + worst case $${worstCaseUsd(limitSeconds).toFixed(2)} passes $${budget.toFixed(2)}; not started`);
    entry.skipped = true; continue;
  }
  const started = Date.now();
  let world = null, ctx = null, hard = null;
  try {
    world = await World.start({ dry: DRY, ports, limitSeconds, keep: has('--keep-logs'), useProxy: !DRY && !!s.proxy, say: (m) => console.log(`     ${m}`) });
    currentGuard = world.guard;
    ctx = makeContext({ world, reporter, minutes: minutesFlag, dry: DRY });
    // The per-scenario hard stop goes the same way out as a signal does.
    const stopped = new Promise((_, reject) => { hard = setTimeout(() => { void world.guard.shutdown().finally(() => reject(new Error(`HARD STOP: ${limitSeconds + 30} s passed`))); }, (limitSeconds + 30) * 1000); hard.unref?.(); });
    await Promise.race([s.run(ctx), stopped]);
  } catch (e) {
    reporter.harness('the scenario ran to its end', false, String(e?.message ?? e).slice(0, 300) + (process.env.MA_DEBUG ? ` @ ${String(e?.stack).split('\n').slice(1, 3).join(' | ')}` : ''));
    if (world) { const t = tailLog(world.dir, 8); if (t) console.log(t.split('\n').map((l) => `     | ${l}`.slice(0, 200)).join('\n')); }
  } finally {
    clearTimeout(hard);
    try { for (const t of ctx?.runners ?? []) await t.stop(); } catch { /* ending */ }
    if (world) {
      try { await world.stopLanes(); } catch { /* ending */ }
      // Dismiss (reported from the real answer), then read what the call cost before the middleware goes.
      let billing = null;
      try {
        const report = await world.guard.dismiss();
        if (ctx?.call && !report?.timedOut) billing = await billingOf(ctx.p[ctx.inviterKey], ctx.call).catch(() => null);
        if (ctx?.call && billing) reporter.measure('billed seconds (ledger, else listening state)', billing.ledgerSeconds ?? billing.listeningSeconds ?? 'unknown');
      } catch { /* ending */ }
      entry.wallSeconds = Math.round((Date.now() - started) / 1000);
      const billed = billing?.ledgerSeconds ?? billing?.listeningSeconds;
      entry.billedSeconds = Number.isFinite(billed) ? billed : null;
      if (!DRY) { const add = budgetState.add({ billedSeconds: entry.billedSeconds, wallSeconds: entry.wallSeconds, limitSeconds }); entry.costUsd = add.usd; entry.estimatedCost = add.estimated; console.log(`     cost: $${add.usd.toFixed(3)}${add.estimated ? ' (estimated from wall time)' : ''}; running total $${budgetState.spentUsd.toFixed(2)} of $${budget.toFixed(2)}`); }
      await world.guard.shutdown();
      currentGuard = null;
    }
  }
  await sleep(300);
}

reporter.table();
if (flag('--out')) {
  const merged = summary.scenarios.map((e) => ({ ...e, ...(reporter.json().find((x) => x.id === e.id) ?? {}) }));
  fs.writeFileSync(flag('--out'), JSON.stringify({ ...summary, totalCostUsd: Math.round(budgetState.spentUsd * 1000) / 1000, scenarios: merged }, null, 2));
}
const bad = reporter.failedHarness.length + reporter.findings.length;
console.log(bad ? `scenarios: ${reporter.failedHarness.length} harness failure(s), ${reporter.findings.length} finding(s)` : 'scenarios: ALL PASS');
process.exit(bad ? 1 : 0);
