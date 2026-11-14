// The voice navigator's machine and people tools (docs/voice-navigator-spec.md
// §4, §6, §7; package P4; catalogue v2 V2-8, V2-12): computer, message,
// call, set_status. Each goes through the call the page's own
// control makes, read from the ToolContext the dock fills from the providers
// the shell already mounts (ComputeHost's useCompute, EmbeddedSocial's
// presence, the composer's useChat path): never a second socket, never a new
// endpoint.
//
// The confirm tools have a planner that runs before the card, with reads
// only: it resolves the initiatives, the computer, the machine and its job or
// the recipient, composes the command and mints the delivery id, so the card
// says exactly what will happen and a cancel leaves nothing behind. The runner
// then acts on that plan and nothing else. `computer` is one tool with five
// actions, each gated by the Cedar action of the button it stands in for
// (catalogue COMPUTER_ACTIONS, checked by prepareToolCall before any request):
//
//   start             initiatives resolved against the user's own list; one
//                     card for the batch with the idle-billing note; one
//                     create({ label, projectId }) per initiative (the lab's
//                     + Computer), a running box reused; a pending toast while
//                     they boot; the batch goes through the action ledger, so a
//                     retry never starts a second box
//   stop              only a box the caller started (`ownerId` on the lab's own
//                     GET /api/devbox/boxes, against the session's sub): the
//                     lab's remove (DELETE /api/devbox/boxes/:boxId), which ends
//                     its billing; a box someone else started is refused, a
//                     second stop answers that it is already stopped
//   open-shell        the library's openShell (the ⌘K palette's call): opens or
//                     focuses the dock's shell tab in the box's workspace, as
//                     run runs there; the model names no directory (sweep 2
//                     M3: no model text reaches a shell); no card
//   hand-work         Local compute's "Hand it work": the user's own paired
//                     machine (GET /api/local-compute/nodes, owner-scoped) and a
//                     work item from the page's pick list (GET
//                     /api/work/suggestions) or a bot (GET /api/bots, with
//                     ManageBots), never a typed prompt; POST
//                     /api/local-compute/nodes/:nodeId/work { workItemId |
//                     botId, requiresReview: true }, the page's default
//   run               a phrase id from PHRASE_TABLE, never model text; the
//                     composed command checked against GET
//                     /api/devbox/allowlist before the card, so the card never
//                     shows a command the server would refuse; safe mode only,
//                     through the provider's runCommand (the same POST
//                     /api/devbox/:sid/command, allowlist and metacharacter
//                     refusal); the stream lands in the compute dock's output
//                     tab (openOutputTab) and the first lines go back
//   message           the recipient resolved by GET …/resolve (P6), a read
//                     only; several matches go back to the model as candidates
//                     with no card; a person's DM is opened (POST /api/social/dms)
//                     only on confirm, so a cancel writes nothing (G14);
//                     a clientDeliveryId minted before the card and reused for
//                     the same channel and text, so a retry never double-posts
//   call              start: the team, channel or person resolved by GET …/resolve,
//                     the card says who is rung; confirm runs the shell call
//                     host's own start (useSocialCall: callConversation for a
//                     team or channel, nobody rung; callPeople for a person,
//                     who is rung, after POST /api/social/dms opens the DM at
//                     confirm), once; refused while a call is live
//   set_status        setStatus + updateMetadata({ statusMessage }) on the
//                     tenant's own lobby entry (`<tenant>:lobby`) and, with a
//                     Social grant, the shell's Social entry, which the
//                     presence tooltip reads; no card and no grant (§4, G10:
//                     it changes only the caller)
//   queue_work        work.ts (G19, V2-9): the target resolved by the page's
//                     own read, the page button's route on confirm, one toast
//                     that follows the server's job id to the end
//   decide            records.ts (V2-10): a row a read handed out, read again
//                     through its page's list, decided by the page button's
//                     route with the card's toggle and note
//
// No React and only `.ts` imports, so `node --test` runs it.

import type { RunCommandPhrase } from './catalogue.ts';
import {
  channelTag, ambiguous, computersOf, done, failed, once, positionRefusal, qs, readFailure, readJson, refused, socialGrantRefusal, TOOL_RUNNERS,
  type CallAccess, type ConfirmPlan, type DeliveryRecord, type PresenceWriter, type ProjectRow, type ToolContext, type ToolResult,
  type VoiceComputer, type VoiceToolArgs, type VoiceToolPlanner, type VoiceToolRunner,
} from './tools.ts';
import { messageAvailability } from '../../pages/search/searchMessageModel.ts';
import type { RosterUser } from '../conversationCallModel.ts';
import { inboundRef } from './inbound.ts';
import { grantRequestNextStep } from '../pageAccess.ts';
import { matchByName, WORK_PLANNERS, WORK_RUNNERS } from './work.ts';
import { RECORD_PLANNERS, RECORD_RUNNERS } from './records.ts';

/** Lines of command output the model gets (§6 caps every list at 10 rows); the panel keeps the rest. */
export const OUTPUT_LINES_TO_MODEL = 10;
/** Lines the dock's panel keeps per run. */
export const OUTPUT_LINES_KEPT = 400;
/** A run that never ends is abandoned after this (the server's own timeout is 120 s). */
export const COMMAND_TIMEOUT_MS = 150_000;
/** How long a delivered message suppresses an identical retry. */
export const DELIVERY_MEMORY_MS = 10 * 60_000;
/** The lab's path: open { page: 'computers' } opens it and computer start's boxes appear in it. */
export const LAB_PATH = '/iq/computers';

// ── the phrase table (§6: the model picks the phrase, the dock owns the text) ──

export interface Phrase {
  /** What the card and the strip call it. */
  label: string;
  /** The command, from the phrase's parameters only; null = the parameters do not compose one. */
  compose(params: { since?: string }): string | null;
}

/**
 * `since` as a git date token: only the words and shapes below, so nothing
 * the model says can reach the command line beyond [a-z0-9.-]. "last night"
 * is yesterday and "this morning" today (G9), as tools.ts parseSince reads
 * them.
 */
export function gitSince(raw: string | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'yesterday' || s === 'last night') return 'yesterday';
  if (s === 'today' || s === 'this morning') return 'midnight';
  if (s === 'last week' || s === 'a week ago') return '1.week.ago';
  const ago = /^(\d{1,3}) (hour|hours|day|days|week|weeks|month|months) ago$/.exec(s);
  if (ago) return `${Number(ago[1])}.${ago[2]!.replace(/s$/, '')}s.ago`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))) return s;
  return null;
}

export const PHRASE_TABLE: Readonly<Record<RunCommandPhrase, Phrase>> = {
  'latest-commits-since-yesterday': { label: 'latest commits since yesterday', compose: () => 'git log --since=yesterday --oneline' },
  'commits-since': { label: 'commits since a date', compose: ({ since }) => { const t = gitSince(since); return t ? `git log --since=${t} --oneline` : null; } },
  status: { label: 'git status', compose: () => 'git status' },
  'diff-stat': { label: 'what changed', compose: () => 'git diff --stat' },
  'list-files': { label: 'the files here', compose: () => 'ls' },
  'working-directory': { label: 'the working directory', compose: () => 'pwd' },
  test: { label: 'the tests', compose: () => 'npm test' },
  'test-python': { label: 'the Python tests', compose: () => 'pytest' },
  lint: { label: 'the linter', compose: () => 'npm run lint' },
  build: { label: 'the build', compose: () => 'npm run build' },
};

/**
 * routes/devbox.ts validateCommand's prefix rule (the middleware catalogue's
 * commandAllowedBy; the drift test holds the two together): a command equal
 * to a trimmed prefix, or starting with one.
 */
export function commandAllowedBy(prefixes: readonly string[], command: string): boolean {
  return prefixes.some((prefix) => command === prefix.trim() || command.startsWith(prefix));
}

/** The safe-mode prefixes this deployment runs (GET /api/devbox/allowlist, the prefixes only). */
export const ALLOWLIST_URL = '/api/devbox/allowlist';

/** The command a phrase composes (exported for the tests and the card). */
export function composeCommand(phrase: string, params: { since?: string }): string | null {
  const p = (PHRASE_TABLE as Record<string, Phrase>)[phrase];
  return p ? p.compose(params) : null;
}

// ── computers ───────────────────────────────────────────────────────────────

const norm = (s: string) => s.trim().toLowerCase();
const computerRow = (c: VoiceComputer) => ({ id: c.id, label: c.label, initiative: c.project, status: c.status });

/** A computer by id, session id, label or (when it has exactly one) its initiative's name. */
export function findComputer(computers: readonly VoiceComputer[], ref: string): { computer: VoiceComputer } | { candidates: VoiceComputer[] } {
  const q = norm(ref);
  const boxes = computers.filter((c) => c.kind !== 'local');
  const exact = boxes.find((c) => c.id === ref || c.sessionId === ref) ?? boxes.find((c) => norm(c.label) === q);
  if (exact) return { computer: exact };
  const byProject = boxes.filter((c) => c.project && norm(c.project) === q);
  if (byProject.length === 1) return { computer: byProject[0]! };
  const loose = byProject.length ? byProject : boxes.filter((c) => norm(c.label).includes(q) || (c.project && norm(c.project).includes(q)));
  if (loose.length === 1) return { computer: loose[0]! };
  return { candidates: loose.length ? loose : boxes };
}

function noComputer(ref: string, candidates: VoiceComputer[]): ToolResult {
  if (!candidates.length) return refused('You have no computers in the Computer Lab. computer start starts one.');
  return ambiguous(`No single computer matches "${ref}". Ask which one.`, candidates.map(computerRow));
}

function computeOrRefusal(ctx: ToolContext): { compute: NonNullable<ToolContext['compute']> } | { result: ToolResult } {
  if (ctx.tenant !== 'orgiq') return { result: refused('Computers are in the Work workspace.') };
  if (!ctx.compute) return { result: refused('The Computer Lab is not available to this session.') };
  return { compute: ctx.compute };
}

// ── computer start ──────────────────────────────────────────────────────────

interface StartPlan { start: Array<{ id: string; name: string }>; reuse: Array<{ id: string; name: string; computer: VoiceComputer }> }

/** A box that is up or coming up; a stopped or failed one is not reused. */
const reusable = (c: VoiceComputer) => c.status !== 'stopped' && c.status !== 'error';

/** The initiatives named, by id or by name, against the user's own list (the same read as list_active_initiatives). */
export function resolveInitiatives(list: readonly ProjectRow[], refs: readonly string[]): { found: ProjectRow[]; missing: string[] } {
  const found: ProjectRow[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const q = norm(ref);
    const hit = list.find((p) => p.id === ref) ?? list.find((p) => norm(p.name) === q)
      ?? (() => { const loose = list.filter((p) => norm(p.name).includes(q)); return loose.length === 1 ? loose[0] : undefined; })();
    if (hit) { if (!found.some((f) => f.id === hit.id)) found.push(hit); } else missing.push(ref);
  }
  return { found, missing };
}

const listNames = (names: string[]) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
export const IDLE_BILLING_NOTE = 'A running computer bills idle time until it stops.';

const planStartComputer: VoiceToolPlanner = async (args, ctx) => {
  const c = computeOrRefusal(ctx);
  if ('result' in c) return c;
  if (!c.compute.canManage) return { result: refused("I can't start computers with your role.") };
  const refs = [...new Set(((args['initiatives'] as string[] | undefined) ?? []).map((r) => r.trim()).filter(Boolean))];
  if (!refs.length) return { result: refused('Name at least one initiative.') };
  const read = await readJson<ProjectRow[]>(ctx, `/api/graph/projects?${qs({ scope: 'mine', limit: 50 })}`);
  if (!read.ok) return { result: readFailure('your initiatives', read.status) };
  const list = Array.isArray(read.body) ? read.body : [];
  const { found, missing } = resolveInitiatives(list, refs);
  if (missing.length) {
    return { result: ambiguous(`I could not find ${listNames(missing.map((m) => `"${m}"`))} among your initiatives. Ask which.`,
      list.slice(0, 10).map((p) => ({ id: p.id, name: p.name }))) };
  }
  const computers = c.compute.computers();
  const plan: StartPlan = { start: [], reuse: [] };
  for (const p of found) {
    const box = computersOf(computers, p.id).find(reusable);
    if (box) plan.reuse.push({ id: p.id, name: p.name, computer: box });
    else plan.start.push({ id: p.id, name: p.name });
  }
  // Nothing to start, nothing to bill: answered at once, no card.
  if (!plan.start.length) return { result: startResult([], plan.reuse) };
  const n = plan.start.length;
  const reusedLine = plan.reuse.length ? ` ${listNames(plan.reuse.map((r) => r.name))} already ${plan.reuse.length === 1 ? 'has' : 'have'} one.` : '';
  const card: ConfirmPlan = {
    title: n === 1 ? `Start a computer for ${plan.start[0]!.name}` : `Start ${n} computers`,
    detail: `${n === 1 ? '' : `For ${listNames(plan.start.map((s) => s.name))}.`}${reusedLine} ${IDLE_BILLING_NOTE}`.trim(),
    data: plan,
  };
  return { plan: card };
};

type Started = { initiativeId: string; initiative: string; computerId?: string; label?: string; state: string; reused?: boolean; error?: string };

function startResult(started: Started[], reuse: StartPlan['reuse']): ToolResult {
  const rows: Started[] = [
    ...started,
    ...reuse.map((r) => ({ initiativeId: r.id, initiative: r.name, computerId: r.computer.id, label: r.computer.label, state: r.computer.status ?? 'unknown', reused: true })),
  ];
  const ok = rows.filter((r) => !r.error);
  const bad = rows.filter((r) => r.error);
  const summary = [
    started.filter((r) => !r.error).length ? `Started ${started.filter((r) => !r.error).length}` : '',
    reuse.length ? `${reuse.length} already running` : '',
    bad.length ? `${bad.length} failed` : '',
  ].filter(Boolean).join('; ') || 'Nothing started';
  const outcome = ok.length ? 'done' : 'failed';
  const res = outcome === 'done'
    ? done('computers', { count: ok.length, rows, lab: LAB_PATH, note: started.length ? 'New computers take a minute or two to boot; they show in the Computer Lab.' : undefined }, summary)
    : failed(summary, { rows });
  return res;
}

const runStartComputer: VoiceToolRunner = async (_args, ctx, planned) => {
  const c = computeOrRefusal(ctx);
  if ('result' in c) return c.result;
  const plan = planned as StartPlan | undefined;
  if (!plan?.start) return refused('A computer starts only after the user confirms its card.');
  // One start per batch: a retry of the same card (or the same request again) never starts a second box.
  const key = `computer:start:${plan.start.map((p) => p.id).sort().join(',')}`;
  return once(ctx, key, () => startNow(ctx, c.compute, plan),
    () => done('computers', { count: plan.start.length, alreadyStarted: true, lab: LAB_PATH }, `Already started for ${listNames(plan.start.map((s) => s.name))}; nothing new was started`));
};

async function startNow(ctx: ToolContext, compute: NonNullable<ToolContext['compute']>, plan: StartPlan): Promise<ToolResult> {
  const c = { compute };
  const names = plan.start.map((s) => s.name);
  const toast = ctx.toast?.pending(names.length === 1 ? `Starting a computer for ${names[0]}` : `Starting ${names.length} computers`, listNames(names));
  const started: Started[] = [];
  for (const p of plan.start) {
    try {
      const box = await c.compute.create({ label: p.name.slice(0, 40), projectId: p.id });
      started.push({ initiativeId: p.id, initiative: p.name, computerId: box.id, label: box.label, state: box.status ?? 'provisioning' });
    } catch (err) {
      started.push({ initiativeId: p.id, initiative: p.name, state: 'failed', error: (err as Error)?.message ?? 'refused' });
    }
  }
  const res = startResult(started, plan.reuse);
  if (toast) {
    if (res.outcome === 'done') ctx.toast!.success(toast, res.summary, 'They show in the Computer Lab as they boot.');
    else ctx.toast!.error(toast, 'Computers did not start', started.map((s) => s.error).filter(Boolean).join('; '));
  }
  return res;
}

// ── computer stop: only the caller's own box ────────────────────────────────

/** The lab's own fleet read: the boxes this caller may see, each with who started it. */
export const BOXES_URL = '/api/devbox/boxes';
interface StopPlan { computer: VoiceComputer }
type FleetBox = VoiceComputer & { ownerId?: string | null };

const planStopComputer: VoiceToolPlanner = async (args, ctx) => {
  const c = computeOrRefusal(ctx);
  if ('result' in c) return c;
  if (!c.compute.canManage) return { result: refused("I can't stop computers with your role.") };
  if (!ctx.userId) return { result: refused('I cannot tell which computers are yours in this session.') };
  const ref = String(args['computer']);
  const read = await readJson<{ boxes?: FleetBox[] }>(ctx, BOXES_URL);
  if (!read.ok) return { result: readFailure('your computers', read.status) };
  const visible = (read.body.boxes ?? []).filter((b) => b && typeof b.id === 'string' && b.kind !== 'local');
  const own = visible.filter((b) => b.ownerId === ctx.userId);
  const found = findComputer(own, ref);
  if ('candidates' in found) {
    // A box the caller can see but did not start is named back (they see it in the lab), never stopped by voice.
    const theirs = findComputer(visible, ref);
    if ('computer' in theirs) return { result: refused(`${theirs.computer.label} was started by someone else; only its owner stops it.`) };
    return { result: own.length ? ambiguous(`No single computer of yours matches "${ref}". Ask which one.`, own.map(computerRow)) : refused('You have no computers of your own running.') };
  }
  const box = found.computer;
  return { plan: {
    title: `Stop ${box.label}`,
    detail: box.status === 'stopped' ? 'It is already stopped; this removes it from the Computer Lab.' : 'It stops the computer and its billing; the workspace stays until it expires.',
    data: { computer: box } satisfies StopPlan,
  } };
};

const runStopComputer: VoiceToolRunner = async (_args, ctx, planned) => {
  const c = computeOrRefusal(ctx);
  if ('result' in c) return c.result;
  const plan = planned as StopPlan | undefined;
  if (!plan?.computer) return refused('A computer stops only after the user confirms its card.');
  const box = plan.computer;
  try {
    await c.compute.remove(box.id);
  } catch (err) {
    const message = (err as Error)?.message ?? '';
    // A second stop (a retry) finds it gone: that is the outcome the user asked for.
    if (/not found|404/i.test(message)) return done('computer_stopped', { computerId: box.id, label: box.label, alreadyStopped: true }, `${box.label} was already stopped`);
    if (/not yours|403|forbidden/i.test(message)) return refused(`${box.label} is not yours to stop.`);
    return failed(`${box.label} did not stop: ${message || 'refused'}`, { computerId: box.id });
  }
  return done('computer_stopped', { computerId: box.id, label: box.label, lab: LAB_PATH }, `Stopped ${box.label}`);
};

// ── computer hand-work: a paired machine, a work item or a bot (Local compute's pick list) ──

export const NODES_URL = '/api/local-compute/nodes';
export const SUGGESTIONS_URL = '/api/work/suggestions';
interface NodeRow { id: string; label: string; acceptJobs?: boolean; presence?: { status?: string } }
interface SuggestionRow { workItemId: string; title: string; initiativeName?: string }
interface HandPlan { nodeId: string; machine: string; origin: { workItemId: string } | { botId: string }; job: string }

const planHandWork: VoiceToolPlanner = async (args, ctx) => {
  if (ctx.tenant !== 'orgiq') return { result: refused('Paired machines are in the Work workspace.') };
  const machine = String(args['machine'] ?? '').trim();
  const job = String(args['job'] ?? '').trim();
  if (!machine || !job) return { result: refused('Name the machine and the work item or bot to hand it.') };
  const nodes = await readJson<{ nodes?: NodeRow[] }>(ctx, NODES_URL);
  if (!nodes.ok) return { result: readFailure('your machines', nodes.status) };
  const mine = nodes.body.nodes ?? [];
  const hits = matchByName(mine, (n) => n.label, machine);
  if (!hits.length) return { result: mine.length ? refused(`None of your machines is called "${machine}".`, { machines: mine.slice(0, 10).map((n) => n.label) }) : refused('You have no paired machines.') };
  if (hits.length > 1) return { result: ambiguous(`Several of your machines match "${machine}". Ask which one.`, hits.map((n) => ({ id: n.id, name: n.label }))) };
  const node = hits[0]!;
  if (node.acceptJobs === false) return { result: refused(`${node.label} is not accepting jobs; switch it on in Local compute first.`) };
  // The page's own pick list: the ranked work items, and the bots this person may run.
  const sugg = await readJson<{ suggestions?: SuggestionRow[] }>(ctx, SUGGESTIONS_URL);
  if (!sugg.ok) return { result: readFailure('the work you can hand over', sugg.status) };
  const items = (sugg.body.suggestions ?? []).filter((x) => typeof x?.workItemId === 'string');
  const bots: Array<{ id: string; name: string }> = [];
  if (ctx.can('ManageBots')) {
    const read = await readJson<{ bots?: Array<{ id: string; name: string; enabled?: boolean; pausedReason?: string | null }> }>(ctx, '/api/bots');
    if (read.ok) bots.push(...(read.body.bots ?? []).filter((b) => b.enabled !== false && !b.pausedReason));
  }
  const choices = [
    ...items.map((i) => ({ title: i.title, origin: { workItemId: i.workItemId } as HandPlan['origin'], what: 'work item' })),
    ...bots.map((b) => ({ title: b.name, origin: { botId: b.id } as HandPlan['origin'], what: 'bot' })),
  ];
  const picked = matchByName(choices, (x) => x.title, job);
  if (!picked.length) return { result: refused(`Nothing you can hand over is called "${job}".`, { choices: choices.slice(0, 10).map((x) => x.title) }) };
  if (picked.length > 1) return { result: ambiguous(`Several things match "${job}". Ask which one.`, picked.map((x) => ({ name: x.title, kind: x.what }))) };
  const choice = picked[0]!;
  return { plan: {
    title: `Hand "${choice.title}" to ${node.label}`,
    detail: `Your machine runs the ${choice.what} with its own login; a run that changes a repo waits for your review.`,
    data: { nodeId: node.id, machine: node.label, origin: choice.origin, job: choice.title } satisfies HandPlan,
  } };
};

const runHandWork: VoiceToolRunner = async (_args, ctx, planned) => {
  const plan = planned as HandPlan | undefined;
  if (!plan?.nodeId) return refused('Work is handed to a machine only after the user confirms its card.');
  const url = `${NODES_URL}/${encodeURIComponent(plan.nodeId)}/work`;
  const body = { ...plan.origin, requiresReview: true };
  const href = `/iq/computers?${qs({ computer: `local:${plan.nodeId}` })}`;
  return once(ctx, `POST ${url} ${JSON.stringify(body)}`, async () => {
    let res: Response;
    try {
      res = await ctx.fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      return failed('Could not reach the server; nothing was handed over.');
    }
    const json = await res.json().catch(() => null) as { id?: unknown; error?: unknown } | null;
    const error = typeof json?.error === 'string' ? json.error : null;
    if (res.status === 401 || res.status === 403) return refused(error ? `Not handed over: ${error}.` : "I can't hand work to machines with your role.");
    if (res.status === 404) return refused(`That machine or ${'botId' in plan.origin ? 'bot' : 'work item'} is gone; nothing was handed over.`);
    if (res.status === 409) return refused(`${plan.machine} did not take it: ${error ?? 'it is not accepting this work'}.`, { page: href });
    if (!res.ok) return failed(`${plan.machine} could not take it (HTTP ${res.status})${error ? `: ${error}` : ''}.`);
    ctx.toast?.success(ctx.toast.pending(`Handing "${plan.job}" to ${plan.machine}`), `"${plan.job}" queued for ${plan.machine}`, 'It shows in the machine\'s runs on Local compute.');
    return done('work_handed', { machine: plan.machine, job: plan.job, runId: typeof json?.id === 'string' ? json.id : undefined, href, waitsForReview: true },
      `"${plan.job}" queued for ${plan.machine}`);
  }, () => done('work_handed', { machine: plan.machine, job: plan.job, href, alreadyHanded: true }, `"${plan.job}" was already handed to ${plan.machine}; nothing was sent again`));
};

// ── computer open-shell ─────────────────────────────────────────────────────

const runOpenShell: VoiceToolRunner = async (args, ctx) => {
  const c = computeOrRefusal(ctx);
  if ('result' in c) return c.result;
  const ref = String(args['computer']);
  const found = findComputer(c.compute.computers(), ref);
  if ('candidates' in found) return noComputer(ref, found.candidates);
  const box = found.computer;
  // The box's own workspace, never a model-supplied path (the schema has no `cwd`; prepareToolCall refuses one).
  const cwd = box.workspace;
  // G30: one shell per box per session. The library's openShell focuses the tab already open for the box (and reopens
  // one the user closed), so a repeat never stacks a second PTY; the dock says it was already open.
  const key = `open-shell:${ctx.sessionId ?? 'dock'}:${box.id}`;
  const book = ctx.ledger ?? SESSION_SHELLS;
  const again = book.has(key);
  const opened = c.compute.openShell({ id: box.id, label: box.label, sessionId: box.sessionId, ...(cwd ? { cwd } : {}) });
  if (!opened.ok) return refused('Every shell tab is in use. Ask the user to close one first.', { limit: 'at-capacity' });
  if (again) {
    return done('shell_opened', { computerId: box.id, label: box.label, alreadyOpen: true, focused: true, note: 'It was already open in this session; it is focused now. Do not open it again.' },
      `Shell on ${box.label} was already open; focused it`);
  }
  book.set(key, { deliveryId: opened.id, state: 'sent', at: ctx.now().getTime() });
  return done('shell_opened', { computerId: box.id, label: box.label, ...(cwd ? { cwd } : {}) }, `Shell on ${box.label}`);
};

/** The shell tabs opened per session when the context carries no ledger (tests, a bare call). */
const SESSION_SHELLS = new Map<string, DeliveryRecord>();

// ── computer run (a phrase, never text) ─────────────────────────────────────

interface CommandPlan { computer: VoiceComputer; command: string; phrase: string; cwd?: string }

const planRunCommand: VoiceToolPlanner = async (args, ctx) => {
  const c = computeOrRefusal(ctx);
  if ('result' in c) return c;
  const phrase = String(args['phrase']);
  const command = composeCommand(phrase, { since: typeof args['since'] === 'string' ? args['since'] : undefined });
  if (!command) {
    return { result: refused(phrase === 'commits-since'
      ? `I could not read "${String(args['since'] ?? '')}" as a date. Say yesterday, last night, this morning, "3 hours ago", "3 days ago", "last week" or a date.`
      : `There is no "${phrase}" command. For anything else, ask the user to open the shell and type it.`) };
  }
  const ref = String(args['computer']);
  const found = findComputer(c.compute.computers(), ref);
  if ('candidates' in found) return { result: noComputer(ref, found.candidates) };
  const box = found.computer;
  // The server's own allowlist, read before the card (G9): the mint already left out the phrases it
  // refuses, and this catches the composed text (a `since` token, an allowlist changed since the mint).
  const allow = await readJson<{ prefixes?: unknown }>(ctx, ALLOWLIST_URL);
  if (!allow.ok) {
    return { result: allow.status === 401 || allow.status === 403 ? refused("I can't run commands on machines with your role.") : readFailure('the command allowlist', allow.status) };
  }
  const prefixes = Array.isArray(allow.body.prefixes) ? allow.body.prefixes.filter((p): p is string => typeof p === 'string') : [];
  if (!commandAllowedBy(prefixes, command)) {
    return { result: refused(`This deployment's safe mode does not run "${command}". Ask the user to open the shell on ${box.label} and type it.`, { computerId: box.id, command }) };
  }
  const plan: CommandPlan = { computer: box, command, phrase, ...(box.workspace ? { cwd: box.workspace } : {}) };
  return { plan: { title: `Run on ${box.label}`, detail: command, data: plan } };
};

/** One SSE frame of the command stream into lines (stdout/stderr), the exit code and an error. */
function absorb(ev: Record<string, unknown>, out: { lines: string[]; partial: string; exitCode: number | null; error?: string }): void {
  const push = (text: string, prefix = '') => {
    const all = (out.partial + text).split('\n');
    out.partial = all.pop() ?? '';
    for (const l of all) if (out.lines.length < OUTPUT_LINES_KEPT) out.lines.push(prefix + l);
  };
  if (ev['type'] === 'stdout' && typeof ev['text'] === 'string') push(ev['text']);
  else if (ev['type'] === 'stderr' && typeof ev['text'] === 'string') push(ev['text']);
  else if (ev['type'] === 'exit') out.exitCode = typeof ev['exitCode'] === 'number' ? ev['exitCode'] : null;
  else if (ev['type'] === 'devbox_error') out.error = typeof ev['error'] === 'string' ? ev['error'] : 'the computer reported an error';
}

const runRunCommand: VoiceToolRunner = async (_args, ctx, planned) => {
  const c = computeOrRefusal(ctx);
  if ('result' in c) return c.result;
  const plan = planned as CommandPlan | undefined;
  if (!plan?.command) return refused('A command runs only after the user confirms its card.');
  const { computer, command } = plan;
  const out = { lines: [] as string[], partial: '', exitCode: null as number | null, error: undefined as string | undefined };
  // One output tab per computer and phrase: a re-run replaces its lines in place (openOutputTab's id rule).
  const tab = `voice-${computer.id}-${plan.phrase}`;
  let tabRefused = false;
  const view = (running: boolean) => {
    const shown = ctx.showOutput?.({
      id: tab, computerId: computer.id, computer: computer.label, command, lines: [...out.lines, ...(out.partial ? [out.partial] : [])],
      running, exitCode: out.exitCode, ...(out.error ? { error: out.error } : {}),
    });
    if (shown === false) tabRefused = true;
  };
  view(true);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), COMMAND_TIMEOUT_MS);
  try {
    // Safe mode, always: the dock never sends `full` (§4, §6). The server's allowlist and metacharacter refusal stay the backstop.
    await c.compute.runCommand(computer.sessionId, { command, mode: 'safe', ...(plan.cwd ? { cwd: plan.cwd } : {}) },
      (ev) => { absorb(ev, out); view(true); }, abort.signal);
  } catch (err) {
    const message = (err as Error)?.message ?? 'refused';
    out.error = message;
    view(false);
    // A 400 from the allowlist reads "not an allowlisted read-only command — switch to full shell…".
    if (/allowlist|metacharacter|not allowed/i.test(message)) {
      return refused(`${computer.label} refused "${command}" in safe mode. Ask the user to open the shell and type it.`, { computerId: computer.id, command, server: message });
    }
    return failed(abort.signal.aborted ? `"${command}" on ${computer.label} did not finish in time.` : `"${command}" on ${computer.label} failed: ${message}`,
      { computerId: computer.id, command });
  } finally {
    clearTimeout(timer);
  }
  if (out.partial) { out.lines.push(out.partial); out.partial = ''; }
  view(false);
  const lines = out.lines.filter((l) => l.trim());
  const body = {
    computerId: computer.id, computer: computer.label, command, exitCode: out.exitCode,
    totalLines: lines.length, lines: lines.slice(0, OUTPUT_LINES_TO_MODEL), truncated: lines.length > OUTPUT_LINES_TO_MODEL,
    ...(out.error ? { error: out.error } : {}),
    ...(tabRefused ? { outputTab: 'Every tab in the compute dock is in use, so the full output is not shown; ask the user to close one.' } : {}),
  };
  if (out.error) return failed(`"${command}" on ${computer.label}: ${out.error}`, body);
  const summary = `${command} on ${computer.label}: ${lines.length ? `${lines.length} line${lines.length === 1 ? '' : 's'}` : 'no output'}${out.exitCode ? `, exit ${out.exitCode}` : ''}`;
  return done('command_output', body, summary);
};

// ── message ─────────────────────────────────────────────────────────────────

interface ResolveBody {
  kind: 'team' | 'channel' | 'person';
  /** `joined` (channels only, G46): whether the caller is a member and so may post there now. */
  match: { id: string; name: string; channelId: string; channel: string; joined?: boolean } | null;
  candidates: Array<{ id: string; name: string }>;
}

interface PostPlan {
  channel: string; name: string; kind: ResolveBody['kind'] | 'thread'; text: string; deliveryId: string; key: string; userId?: string;
  /** A thread reply (G23): the inbound message it quotes, as the composer's `metadata.replyTo`. */
  replyTo?: { messageId: string; author: string; text: string; timestamp?: string };
  /** A record shared with the message (G24): granted read-only to the conversation at confirm, then referenced in the post. */
  attachment?: Attachment;
}

/** G24: what `attach` shares, fixed by the planner from a row this session's reads (or the page) returned. */
interface Attachment { kind: 'initiative' | 'work-item'; id: string; title: string; href: string | null; nodeId: string }

/** The Communication plane's Share (WorkSharing.tsx ShareNodeForm): a read-only grant of work nodes to one conversation. */
export const WORK_SHARING_URL = '/api/social/plane/work-sharing';
/** How long the shared view lasts: the route's own ceiling, a day. */
export const SHARE_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * `attach` (G24): only a work item or an initiative this session already read (a kept row or a row of the page
 * in view), so the voice never shares what the user could not see; for a person, only one who holds a grant in
 * this workspace (GET /api/roster/users?userIds=), since the link would not open for anyone else.
 */
async function planAttachment(ctx: ToolContext, raw: unknown, to: { userId?: string; label: string }): Promise<{ attachment: Attachment } | { result: ToolResult }> {
  const given = String(raw).trim();
  const strict = positionRefusal(ctx, given);
  if (strict) return { result: strict };
  const kept = ctx.results?.find(given) ?? null;
  const onPage = kept ? null : ctx.page?.()?.rows.find((r) => r.ref === given) ?? null;
  const row = kept ? { ref: kept.ref, title: kept.title, href: kept.href } : onPage ? { ref: onPage.ref, title: onPage.title, href: onPage.href ?? null } : null;
  if (!row) return { result: refused('Attach a record a result in this session named, by its ref ("work-item:<id>", "initiative:<id>") or its position; list or open it first. Nothing was sent.') };
  const m = /^(work-item|initiative):([A-Za-z0-9:_-]{1,200})$/.exec(row.ref);
  if (!m) return { result: refused('Only a work item or an initiative can be shared with a message. Nothing was sent.') };
  const kind = m[1] as Attachment['kind'];
  const id = m[2]!;
  if (to.userId) {
    const read = await readJson<{ inTenant?: string[] }>(ctx, `/api/roster/users?${qs({ userIds: to.userId })}`);
    if (!read.ok) return { result: readFailure(`whether ${to.label} can open it`, read.status) };
    if (!(read.body.inTenant ?? []).includes(to.userId)) {
      return { result: refused(`${to.label} has no access to this workspace, so a view of "${row.title}" cannot be granted to them. Send the message without it, or pick someone in this workspace. Nothing was sent.`, { code: 'no-grant' }) };
    }
  }
  return { attachment: { kind, id, title: row.title, href: row.href, nodeId: kind === 'work-item' ? `work:${id}` : `initiative:${id}` } };
}

/** At confirm: grant the conversation a read-only view (the plane's Share); null when granted, else the refusal. */
async function shareAttachment(ctx: ToolContext, channel: string, a: Attachment, label: string): Promise<ToolResult | null> {
  let res: Response;
  try {
    res = await ctx.fetch(WORK_SHARING_URL, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience: { kind: 'conversation', id: channel }, nodeIds: [a.nodeId], disclosure: 'summary', durationMs: SHARE_FOR_MS }),
    });
  } catch {
    return failed(`Could not reach the server to share "${a.title}"; nothing was sent.`);
  }
  if (res.ok) return null;
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  const why = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
  if (res.status === 403 || res.status === 404 || res.status === 400) return refused(`A view of "${a.title}" cannot be granted to ${label} (${why}); nothing was sent.`, { code: 'no-grant' });
  return failed(`Sharing "${a.title}" failed (${why}); nothing was sent.`);
}

/** The DM button's own call (routes/social.ts POST /dms): writes the pair's membership, at confirm only (G14). */
export const OPEN_DM_URL = '/api/social/dms';

/**
 * Opens the caller's DM with `userId` now that the user confirmed: the
 * resolver only named it, so a cancelled or ambiguous card left nothing
 * behind. Null when it is open and is the channel the card showed; else the
 * result that ends the call with nothing sent or rung.
 */
async function openDm(ctx: ToolContext, userId: string, channel: string, fallback: string): Promise<ToolResult | null> {
  let res: Response;
  try {
    res = await ctx.fetch(OPEN_DM_URL, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
  } catch {
    return failed('Could not reach the server to open the conversation; nothing was sent.');
  }
  if (res.status === 401 || res.status === 403) return socialGrantRefusal(ctx, fallback);
  if (!res.ok) return failed(`The conversation could not be opened (HTTP ${res.status}); nothing was sent.`);
  const body = await res.json().catch(() => null) as { channel?: unknown } | null;
  if (body?.channel !== channel) return failed('The conversation that opened is not the one on the card; nothing was sent.');
  return null;
}

const deliveryKey = (channel: string, text: string) => `${channel}\u0000${text}`;

function newDeliveryId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `vd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The id for this channel and text: reused while one is remembered, minted otherwise (before the card). */
export function deliveryFor(book: Map<string, DeliveryRecord>, channel: string, text: string, now: number): DeliveryRecord {
  const key = deliveryKey(channel, text);
  const known = book.get(key);
  if (known && (known.state !== 'sent' || now - known.at < DELIVERY_MEMORY_MS)) return known;
  const fresh: DeliveryRecord = { deliveryId: newDeliveryId(), state: 'pending', at: now };
  book.set(key, fresh);
  return fresh;
}

// A channel's `name` here is its slug (the resolver's `id`): the voice says "#auth-migration", as the page shows it.
const where = (kind: PostPlan['kind'], name: string) => (kind === 'person' || kind === 'thread' ? name : kind === 'team' ? `the ${name} team` : channelTag(name));

type Match = NonNullable<ResolveBody['match']>;
type Target = { kind: 'team' | 'channel' | 'dm'; name: string };

/**
 * Where a message or a call goes (G39, session vs_8bb50a16): the Social
 * resolver first (GET …/resolve, the Social roster's names, teams and
 * channels). For a person it does not know, outside the Social tenant, the
 * Search page's own bridge: the name matched against the people this
 * session's reads showed (`person:` rows; else one GET /api/search
 * type=person in orgiq), then GET /api/roster/users?personIds= and the page's
 * rules (searchMessageModel.ts messageAvailability: no Work sign-in, not in
 * Social, yourself). A match carries the user id and the DM lobby, and the
 * confirm-time POST /api/social/dms opens it as before (G14).
 */
async function resolveTarget(ctx: ToolContext, social: NonNullable<ToolContext['social']>, target: Target, say: { verb: string; nothing: string }): Promise<{ kind: ResolveBody['kind']; match: Match } | { result: ToolResult }> {
  const kind = target.kind === 'dm' ? 'person' : target.kind;
  const read = await readJson<ResolveBody>(ctx, `${social.api}/resolve?${qs({ kind, name: target.name })}`);
  if (!read.ok) {
    if (read.status === 404 && kind === 'person' && ctx.tenant !== 'social') return directoryPerson(ctx, target.name, say);
    if (read.status === 404) return { result: refused(`There is no ${kind} called "${target.name}" you can ${say.verb}.`) };
    if (read.status === 0) return { result: failed(`Could not reach the server to find the ${kind === 'person' ? 'person' : kind}.`) };
    return { result: readFailure(kind === 'person' ? 'the person' : `the ${kind}`, read.status) };
  }
  if (!read.body.match) {
    return { result: ambiguous(`Several ${kind === 'person' ? 'people' : `${kind}s`} match "${target.name}". Ask which one; ${say.nothing}.`,
      read.body.candidates.map((c) => ({ id: c.id, name: c.name }))) };
  }
  return { kind, match: read.body.match };
}

/** The directory half of resolveTarget: a person the page showed, bridged to the user who signs in as them. */
async function directoryPerson(ctx: ToolContext, name: string, say: { verb: string; nothing: string }): Promise<{ kind: 'person'; match: Match } | { result: ToolResult }> {
  const nobody = (): { result: ToolResult } => ({ result: refused(`No one in Social or the directory is called "${name}". Search people first, then ${say.verb} a row by name.`, { code: 'not-found' }) });
  let people: Array<{ personId: string; name: string }> = (ctx.results?.ofKind('person') ?? []).map((r) => ({ personId: r.ref.slice('person:'.length), name: r.title }));
  let hits = matchByName(people, (p) => p.name, name);
  if (!hits.length && ctx.tenant === 'orgiq' && ctx.can('Search')) {
    const found = await readJson<{ results?: Array<{ id?: string; title?: string; type?: string }> }>(ctx, `/api/search?${qs({ q: name, type: 'person', limit: 5 })}`);
    people = found.ok ? (found.body.results ?? []).flatMap((r) => (r.id && r.title && (r.type ?? 'person') === 'person' ? [{ personId: r.id, name: r.title }] : [])) : [];
    hits = matchByName(people, (p) => p.name, name);
  }
  if (!hits.length) return nobody();
  if (hits.length > 1) return { result: ambiguous(`Several people match "${name}". Ask which one; ${say.nothing}.`, hits.slice(0, 10).map((p) => ({ name: p.name, ref: `person:${p.personId}` }))) };
  const person = hits[0]!;
  const roster = await readJson<{ users?: RosterUser[]; unlinked?: string[] }>(ctx, `/api/roster/users?${qs({ personIds: person.personId })}`);
  if (!roster.ok) return { result: readFailure(`who signs in as ${person.name}`, roster.status) };
  const verdict = messageAvailability({ people: [person], users: roster.body.users ?? [], selfUserId: ctx.userId ?? null });
  if (!verdict.ok) return { result: refused(`${verdict.reason}.`) };
  return { kind: 'person', match: { id: verdict.target.userId, name: verdict.target.displayName, channelId: verdict.lobby, channel: verdict.lobby } };
}

/**
 * A reply to an inbound message (G23): its own conversation, a quote-reply of it, no resolve. Only a message
 * that reached this user's socket in this dock's life (inbound.ts), and only one with a conversation to answer in.
 */
function planThreadReply(args: Record<string, unknown>, ctx: ToolContext, social: NonNullable<ToolContext['social']>): ReturnType<VoiceToolPlanner> {
  const thread = String(args['thread']).trim();
  const item = /^message:[A-Za-z0-9_.:-]{1,190}$/.test(thread) ? ctx.inbox?.find(thread) ?? null : null;
  if (!item) return Promise.resolve({ result: refused('There is no inbound message with that ref in this session; pass the ref the portal gave ("message:<id>").') });
  if (!item.channel) return Promise.resolve({ result: refused('That notification has no conversation to reply in. Name a person, team or channel instead.') });
  const text = String(args['text']);
  const now = ctx.now().getTime();
  const record = deliveryFor(social.deliveries, item.channel, text, now);
  const label = item.where === 'a direct message' ? item.sender || 'them' : item.where || item.sender || 'that conversation';
  if (record.state === 'sent') return Promise.resolve({ result: done('posted', { to: label, posted: true, alreadyPosted: true, thread: inboundRef(item) }, `Already replied to ${label}; nothing was sent again`) });
  const plan: PostPlan = {
    channel: item.channel, name: label, kind: 'thread', text, deliveryId: record.deliveryId, key: deliveryKey(item.channel, text),
    ...(item.kind === 'message' ? { replyTo: { messageId: item.id, author: item.sender || 'Unknown', text: item.text.slice(0, 280), timestamp: new Date(item.at).toISOString() } } : {}),
  };
  if (args['attach'] == null) return Promise.resolve({ plan: { title: `Reply to ${label}`, detail: text, data: plan } });
  return planAttachment(ctx, args['attach'], { label }).then((att) => ('result' in att ? att
    : { plan: { title: `Reply to ${label}`, detail: [text, `With a read-only view of "${att.attachment.title}" for 24 hours.`], data: { ...plan, attachment: att.attachment } } }));
}

/** The post failures the chat host names (socialChatDelivery.ts SocialSendFailure); anything else is `rejected`. */
const SEND_FAILURES: ReadonlySet<string> = new Set(['not-connected', 'not-a-member', 'rejected', 'receipt-timeout', 'timeout']);
const sendFailure = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SEND_FAILURES.has(code) ? code : 'rejected';
};

const planSendChat: VoiceToolPlanner = async (args, ctx) => {
  const social = ctx.social;
  // An initiative whose discussion is a channel this viewer cannot reach (no Social access): a message with no target
  // is refused with the page's own notice and the Social access next step, never posted to the old thread.
  const unreachable = ctx.page?.()?.channel?.noAccessReason ?? null;
  const untargeted = args['target'] == null && !(typeof args['thread'] === 'string' && args['thread'].trim());
  if (unreachable && untargeted) return { result: socialGrantRefusal(ctx, `${unreachable} ${grantRequestNextStep('social', null).label}.`, unreachable) };
  if (!social) return { result: socialGrantRefusal(ctx, 'Messages go through Social, which this session cannot reach.') };
  // G46: the socket is down, so no card: the voice says Social is not connected instead of a card whose post fails.
  if (social.unavailable) return { result: refused(social.unavailable, { code: 'not-connected' }) };
  if (typeof args['thread'] === 'string' && args['thread'].trim()) return planThreadReply(args, ctx, social);
  // On a page whose discussion is a channel (an initiative bound to one), a message with no target goes there.
  const pageChannel = ctx.page?.()?.channel?.slug ?? null;
  const target = (args['target'] as { kind: 'team' | 'channel' | 'dm'; name: string } | null | undefined)
    ?? (pageChannel ? { kind: 'channel' as const, name: pageChannel } : undefined);
  if (!target) return { result: refused('Say where it goes: a team, a channel or a person (target), or the inbound message it answers (thread).') };
  const text = String(args['text']);
  const resolved = await resolveTarget(ctx, social, target, { verb: 'post to', nothing: 'nothing was sent' });
  if ('result' in resolved) return resolved;
  const { kind, match } = resolved;
  // G46: a channel the caller never joined refuses the socket's join (`not-a-member`), so the post could only fail.
  if (kind === 'channel' && match.joined === false) {
    return { result: refused(`You are not a member of ${channelTag(match.id)}, so nothing can be posted there yet. Offer to join it (update ref "channel:${match.id}", fields member true), then post.`,
      { code: 'not-a-member', channel: `channel:${match.id}` }) };
  }
  const body = { match };
  const now = ctx.now().getTime();
  const record = deliveryFor(social.deliveries, body.match.channel, text, now);
  // A channel is named by its slug (match.id), as the page shows it; a team or a person by name.
  const named = kind === 'channel' ? body.match.id : body.match.name;
  const label = where(kind, named);
  if (record.state === 'sent') {
    return { result: done('posted', { to: label, posted: true, alreadyPosted: true },
      `Already posted to ${label}; nothing was sent again`) };
  }
  // A person's DM is only named here; the runner opens it on confirm (G14), so the plan keeps the peer's id.
  const plan: PostPlan = { channel: body.match.channel, name: named, kind, text, deliveryId: record.deliveryId, key: deliveryKey(body.match.channel, text),
    ...(kind === 'person' ? { userId: body.match.id } : {}) };
  // The card shows the channel and the text verbatim (§6): the message is sent exactly as shown.
  const title = kind === 'person' ? `Message ${body.match.name}` : `Post to ${label}`;
  if (args['attach'] == null) return { plan: { title, detail: text, data: plan } };
  const att = await planAttachment(ctx, args['attach'], { ...(plan.userId ? { userId: plan.userId } : {}), label });
  if ('result' in att) return att;
  return { plan: { title, detail: [text, `With a read-only view of "${att.attachment.title}" for 24 hours.`], data: { ...plan, attachment: att.attachment } } };
};

const runSendChat: VoiceToolRunner = async (_args, ctx, planned) => {
  const social = ctx.social;
  const plan = planned as PostPlan | undefined;
  if (!plan) return refused('A message is sent only after the user confirms its card.');
  if (!social) return socialGrantRefusal(ctx, 'Messages go through Social, which this session cannot reach.');
  const label = where(plan.kind, plan.name);
  const record = social.deliveries.get(plan.key) ?? { deliveryId: plan.deliveryId, state: 'pending' as const, at: ctx.now().getTime() };
  if (record.state === 'sent') return done('posted', { to: label, posted: true, alreadyPosted: true }, `Already posted to ${label}`);
  if (plan.kind === 'person') {
    if (!plan.userId) return refused('A message to a person is sent only after the user confirms its card.');
    const blocked = await openDm(ctx, plan.userId, plan.channel, "I can't message people with your role.");
    if (blocked) return blocked;
  }
  // G24: the view is granted before anything is posted; a refusal sends nothing.
  const att = plan.attachment;
  if (att) {
    const blocked = await shareAttachment(ctx, plan.channel, att, label);
    if (blocked) return blocked;
  }
  // A direct message carries the record as a page reference (the DM composer's own card); elsewhere its link is in the text.
  const dm = plan.channel.startsWith('social:dm:');
  const text = att && !dm && att.href ? `${plan.text}\n${att.title}: ${att.href}` : plan.text;
  // G46: the socket went down while the card was open: nothing is sent, and the voice says why.
  if (social.unavailable) return failed(`Nothing was posted to ${label}: ${social.unavailable}`, { code: 'not-connected' });
  social.deliveries.set(plan.key, { ...record, state: 'pending' });
  try {
    await social.send({ channel: plan.channel, text, deliveryId: plan.deliveryId, ...(plan.replyTo ? { replyTo: plan.replyTo } : {}),
      ...(att && dm ? { pageReference: { kind: att.kind, id: att.id } } : {}) });
  } catch (err) {
    social.deliveries.set(plan.key, { ...record, state: 'failed', at: ctx.now().getTime() });
    const code = sendFailure(err);
    if (code === 'not-a-member') return failed(`You are not a member of ${label}, so nothing was posted. Join it first, then post.`, { code });
    return failed(`The message to ${label} was not confirmed: ${(err as Error)?.message ?? 'no receipt'}. A retry reuses the same delivery, so it cannot post twice.`, { code });
  }
  social.deliveries.set(plan.key, { ...record, state: 'sent', at: ctx.now().getTime() });
  return done('posted', { to: label, posted: true, ...(plan.kind === 'thread' ? { thread: plan.channel } : {}), ...(att ? { shared: att.title, sharedFor: '24 hours' } : {}) }, plan.kind === 'thread' ? `Replied to ${label}` : `Posted to ${label}`);
};

// ── call: start, or join the live huddle the index shows (V2-12) ─────────────

interface CallPlan { kind: ResolveBody['kind']; name: string; channel: string; userId?: string; title: string }

/** The call host a call may use, or why it cannot go ahead (before the card and again at confirm). */
function callRefusal(ctx: ToolContext): { calls: CallAccess } | { result: ToolResult } {
  if (!ctx.social) return { result: socialGrantRefusal(ctx, 'Calls go through Social, which this session cannot reach.') };
  if (!ctx.calls) return { result: refused('Calls are not available on this page.') };
  if (ctx.calls.unavailable) return { result: refused(ctx.calls.unavailable) };
  const active = ctx.calls.active();
  if (active) return { result: refused(`You are already in a call (${active.title}). Leave it first.`) };
  return { calls: ctx.calls };
}

const planStartCall: VoiceToolPlanner = async (args, ctx) => {
  const gate = callRefusal(ctx);
  if ('result' in gate) return gate;
  const social = ctx.social!;
  const target = args['target'] as { kind: 'team' | 'channel' | 'dm'; name: string };
  const resolved = await resolveTarget(ctx, social, target, { verb: 'call', nothing: 'no call was started' });
  if ('result' in resolved) return resolved;
  const { kind, match: m } = resolved;
  const plan: CallPlan = kind === 'person'
    ? { kind, name: m.name, channel: m.channel, userId: m.id, title: m.name }
    // A channel is named by its slug (the resolver's id), as the Social page's own call names it (`#<slug>`).
    : { kind, name: m.name, channel: m.channel, title: kind === 'team' ? `${m.name} team` : channelTag(m.id) };
  // Who the call reaches is the card (§6): a person is rung; a team or channel huddle rings nobody.
  return { plan: kind === 'person'
    ? { title: `Call ${m.name}`, detail: `This rings ${m.name}.`, data: plan }
    : { title: `Start a huddle in ${kind === 'team' ? `the ${m.name} team` : plan.title}`, detail: 'Nobody is rung; anyone who opens it sees the huddle and can join.', data: plan } };
};

const runStartCall: VoiceToolRunner = async (_args, ctx, planned) => {
  const plan = planned as CallPlan | undefined;
  if (!plan) return refused('A call starts only after the user confirms its card.');
  // Checked again at confirm time: a call may have started while the card was up.
  const gate = callRefusal(ctx);
  if ('result' in gate) return gate.result;
  if (plan.kind === 'person') {
    // The DM lobby's membership is written now, not when the name was resolved (G14): the gateway admits the call by it.
    const blocked = await openDm(ctx, plan.userId!, plan.channel, "I can't start calls with your role.");
    if (blocked) return blocked;
    // The DM opened while the card was up: a call may have started meanwhile.
    const again = callRefusal(ctx);
    if ('result' in again) return again.result;
    again.calls.callPeople([{ userId: plan.userId!, displayName: plan.name }]);
  } else gate.calls.callConversation({ channel: plan.channel, title: plan.title });
  return plan.kind === 'person'
    ? done('call_started', { with: plan.name, rung: true }, `Calling ${plan.name}`)
    : done('call_started', { in: plan.title, rung: false }, `Huddle starting in ${plan.title}`);
};

/**
 * join: the huddles live now, from the social index the activity read uses
 * (GET /api/social/search in Social, the plane's search elsewhere, type
 * huddle). The model names where (a channel, a team, a person), resolved by
 * GET …/resolve as start does; the dock joins only when the index shows a live
 * huddle there, so "join" never starts one. Without a target, the one live
 * huddle in a channel is it. The card says who is in it; confirm runs the call
 * host's own start on that conversation's lobby, which walks into the live
 * call (useSocialCall's rejoin), once. Refused while already in a call.
 */
interface Huddle { id: string; title: string; subtitle?: string }

async function liveHuddles(ctx: ToolContext): Promise<{ rows: Huddle[] } | { result: ToolResult }> {
  const url = ctx.tenant === 'social' ? '/api/social/search' : '/api/social/plane/search';
  const read = await readJson<{ results?: Array<Record<string, unknown>> }>(ctx, `${url}?${qs({ q: 'live huddles', type: 'huddle', limit: 50 })}`);
  if (!read.ok) return { result: readFailure('the live huddles', read.status) };
  return { rows: (read.body.results ?? []).filter((r) => r['type'] === 'huddle' && r['status'] === 'live' && typeof r['id'] === 'string' && typeof r['title'] === 'string')
    .map((r) => ({ id: r['id'] as string, title: r['title'] as string, ...(typeof r['subtitle'] === 'string' ? { subtitle: r['subtitle'] } : {}) })) };
}

const planJoinCall: VoiceToolPlanner = async (args, ctx) => {
  const gate = callRefusal(ctx);
  if ('result' in gate) return gate;
  const social = ctx.social!;
  const live = await liveHuddles(ctx);
  if ('result' in live) return live;
  if (!live.rows.length) return { result: refused('Nobody is in a huddle you can see right now. Start one instead.') };
  let target = args['target'] as { kind: 'team' | 'channel' | 'dm'; name: string } | undefined;
  if (!target) {
    // "Join the huddle": the one live in a channel, named by its own title ("Live huddle in #general").
    const inChannels = live.rows.map((h) => /^Live huddle in #([a-z0-9][a-z0-9-]*)$/i.exec(h.title)?.[1]).filter((x): x is string => !!x);
    if (live.rows.length !== 1 || inChannels.length !== 1) {
      return { result: ambiguous('Several huddles are live. Ask which one; say where it is.', live.rows.map((h) => ({ title: h.title, subtitle: h.subtitle }))) };
    }
    target = { kind: 'channel', name: inChannels[0]! };
  }
  const resolved = await resolveTarget(ctx, social, target, { verb: 'join', nothing: 'nothing was joined' });
  if ('result' in resolved) return resolved;
  const { kind, match: m } = resolved;
  // The index names a huddle by where it is: "#<slug>" for a channel, the team's name, the people in a DM.
  const where = kind === 'channel' ? channelTag(m.id) : m.name;
  const huddle = live.rows.find((h) => h.title.toLowerCase() === `live huddle in ${where.toLowerCase()}`)
    ?? live.rows.find((h) => h.title.toLowerCase().includes(m.name.toLowerCase()));
  if (!huddle) return { result: refused(`Nobody is in a huddle in ${kind === 'channel' ? where : m.name} right now. Start one instead.`) };
  const title = kind === 'team' ? `${m.name} team` : kind === 'channel' ? where : m.name;
  const plan: CallPlan = { kind, name: m.name, channel: m.channel, title };
  return { plan: { title: `Join the huddle in ${title}`, detail: huddle.subtitle ? `${huddle.subtitle}.` : 'Join the people already in it.', data: { ...plan, join: true } } };
};

const runJoinCall: VoiceToolRunner = async (_args, ctx, planned) => {
  const plan = planned as (CallPlan & { join?: boolean }) | undefined;
  if (!plan?.join) return refused('A huddle is joined only after the user confirms its card.');
  // Checked again at confirm time: a call may have started while the card was up.
  const gate = callRefusal(ctx);
  if ('result' in gate) return gate.result;
  // The conversation's own start, which walks into the call live in its lobby (useSocialCall's rejoin), never rings anyone.
  gate.calls.callConversation({ channel: plan.channel, title: plan.title });
  return done('call_joined', { in: plan.title, rung: false }, `Joining the huddle in ${plan.title}`);
};

const planCall: VoiceToolPlanner = async (args, ctx) => {
  if (args['action'] === 'join') return planJoinCall(args, ctx);
  if (!args['target']) return { result: refused('Say where to start the call: a team, a channel or a person.') };
  return planStartCall(args, ctx);
};

const runCall: VoiceToolRunner = async (args, ctx, plan) => (args['action'] === 'join' ? runJoinCall(args, ctx, plan) : runStartCall(args, ctx, plan));

// ── set_status ──────────────────────────────────────────────────────────────

const runSetStatus: VoiceToolRunner = async (args, ctx) => {
  // G10: the tenant's own presence entry first (the lobby the shell announces on; no grant, it changes only the
  // caller), then the Social one as a second write when the session holds Social. Either alone is enough.
  const lobby = ctx.presence?.lobby() ?? null;
  const writes: Array<{ on: string; writer: PresenceWriter }> = [
    ...(lobby ? [{ on: 'workspace', writer: lobby }] : []),
    ...(ctx.social?.presence ? [{ on: 'Social', writer: ctx.social.presence }] : []),
  ];
  if (!writes.length) return refused('Your presence is not connected right now. Try again in a moment.');
  const status = String(args['status']);
  const message = typeof args['message'] === 'string' ? args['message'].trim() : undefined;
  for (const { writer } of writes) {
    writer.setStatus(status);
    // Only the dictated message (§10): an omitted one leaves the current message as it is.
    if (message !== undefined) writer.updateMetadata({ statusMessage: message || null });
  }
  return done('status_set', { status, ...(message ? { message } : {}), on: writes.map((w) => w.on) },
    message ? `Status: ${status}, "${message}"` : `Status: ${status}`);
};

// ── computer: one tool, five actions ────────────────────────────────────────

/** What each action needs beyond `action`; missing ones are refused before any request. */
const COMPUTER_NEEDS: Readonly<Record<string, readonly string[]>> = {
  start: ['initiatives'], stop: ['computer'], 'open-shell': ['computer'], run: ['computer', 'phrase'], 'hand-work': ['machine', 'job'],
};
const NEED_WORDS: Readonly<Record<string, string>> = {
  initiatives: 'the initiatives', computer: 'the computer', phrase: 'the command', machine: 'the machine', job: 'the work item or bot',
};

function computerArgsProblem(args: VoiceToolArgs): ToolResult | null {
  const missing = (COMPUTER_NEEDS[String(args['action'])] ?? []).filter((k) => args[k] === undefined);
  if (!missing.length) return null;
  if (missing.includes('phrase')) return refused('Name the command to run from the phrase table; for anything else, ask the user to open the shell and type it.');
  return refused(`Name ${missing.map((k) => NEED_WORDS[k]).join(' and ')} to ${String(args['action']).replace('-', ' ')}.`);
}

const COMPUTER_PLANNERS: Readonly<Record<string, VoiceToolPlanner>> = {
  start: planStartComputer, stop: planStopComputer, run: planRunCommand, 'hand-work': planHandWork,
};
const COMPUTER_RUNNERS: Readonly<Record<string, VoiceToolRunner>> = {
  start: runStartComputer, stop: runStopComputer, 'open-shell': runOpenShell, run: runRunCommand, 'hand-work': runHandWork,
};

/** open-shell has no card, so no plan (null); every other action plans before its card. */
const planComputer: VoiceToolPlanner = async (args, ctx) => {
  const problem = computerArgsProblem(args);
  if (problem) return { result: problem };
  const planner = COMPUTER_PLANNERS[String(args['action'])];
  return planner ? planner(args, ctx) : null;
};

const runComputer: VoiceToolRunner = async (args, ctx, plan) => {
  const problem = computerArgsProblem(args);
  if (problem) return problem;
  const runner = COMPUTER_RUNNERS[String(args['action'])];
  return runner ? runner(args, ctx, plan) : refused(`A computer cannot "${String(args['action'])}".`);
};

// ── the tables ──────────────────────────────────────────────────────────────

export const ACTION_RUNNERS: Readonly<Record<string, VoiceToolRunner>> = {
  computer: runComputer,
  message: runSendChat,
  call: runCall,
  set_status: runSetStatus,
  ...WORK_RUNNERS,
  ...RECORD_RUNNERS,
};

/** Every catalogue tool's runner: the reads (tools.ts) and the actions. */
export const VOICE_RUNNERS: Readonly<Record<string, VoiceToolRunner>> = { ...TOOL_RUNNERS, ...ACTION_RUNNERS };

/** The planners that run before a confirm card. */
export const VOICE_PLANNERS: Readonly<Record<string, VoiceToolPlanner>> = {
  computer: planComputer,
  message: planSendChat,
  call: planCall,
  ...WORK_PLANNERS,
  ...RECORD_PLANNERS,
};

export type { VoiceToolArgs };
