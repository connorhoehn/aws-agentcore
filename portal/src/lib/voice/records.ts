// The voice navigator's record actions (catalogue v2, docs/voice-tool-inventory.md
// §3): `decide` (V2-10), and `create` and `update` (V2-11). Each is a page
// button said out loud: the route that button calls, the body it sends, the
// Cedar action it is gated on, behind the dock's Confirm card.
//
// decide's rules:
// - the model names a row by the ref a read of this session handed out
//   (`approval:r-9`, `change:cr-1`) or its position in the last result, never
//   a name or a path; the planner then reads that row again through the read
//   its page lists it from, so a decision only ever reaches a row the
//   persona's own read returns, and the card shows what it is (the requester
//   and the item, the transaction's amount, the change's title);
// - can() holds the button's action for the decision before any request
//   (catalogue DECIDE_ACTIONS), and again at confirm when the card's toggle
//   flipped the decision; the route checks it again (the amount, the author);
// - the card carries `fields` (the library's approve / reject toggle and
//   note) where the row has both; a click answers { decision, note } and the
//   runner sends that; a voice "yes" sends the arguments;
// - a refusal from the route is said as the route said it (the change's
//   author is told someone else must decide it), and names no row the
//   persona could not read; a second decision on a decided row is the
//   route's own 409 / 404, said as "already decided", and the dock's ledger
//   never sends the same decision twice.
//
// No React and only `.ts` imports, so `node --test` runs it.

import { CREATE_ACTIONS, CREATE_FIELDS, DECIDE_ACTIONS, UPDATE_ACTIONS } from './catalogue.ts';
import { parseRef, type Rec } from './kinds.ts';
import { DELEGATION_REASON_MIN, DELEGATION_WINDOWS, JUSTIFICATION_MIN, delegationBody } from '../accessRequests.ts';
import { WORK_PLANNERS, WORK_RUNNERS, matchByName } from './work.ts';
import { dialogueRows, matchDialogueRow, optionOutcome, type DialogueRow } from '../../pages/decisions/decisionDialogue.ts';
import {
  MAX_FIELD_CHARS, channelTag, ambiguous, deliveryIdFor, done, failed, findByName, localHref, positionRefusal, once, pageRowNamed, qs, readFailure, readJson, refused, resolveSprint, samePerson, sayLine, socialGrantRefusal, workItemRow,
  type CardAnswer, type ConfirmPlan, type ToolContext, type ToolResult, type VoiceToolArgs, type VoiceToolPlanner, type VoiceToolRunner,
} from './tools.ts';
import { safeLabel } from './inbound.ts';

const enc = encodeURIComponent;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const dig = (r: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Rec)[k] : undefined), r);
const usd = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(2)}` : null);

type Verb = 'approve' | 'reject' | 'deliver';

/** The spoken decision as the card's verb: accept is approve, discard is reject. */
function verbOf(decision: string): Verb {
  return decision === 'deliver' ? 'deliver' : decision === 'reject' || decision === 'discard' ? 'reject' : 'approve';
}

/** One decision's request: the page button's route and body, with what the card says it does. */
interface Send { method: 'POST' | 'PATCH' | 'DELETE'; url: string; body: Record<string, unknown> }

/** What the planner fixed from the row the persona's own read returned. */
interface DecidePlan {
  kind: string;
  id: string;
  title: string;
  /** The verbs this row offers, each a fixed request; `note` is filled in at send time. */
  sends: Partial<Record<Verb, {
    send: (note: string | undefined, optionId?: string) => Send; needsNote?: string; said: string; word?: string;
    /** What else the answer says happened, joined to the say line's one sentence after a semicolon (null: nothing). */
    after?: (body: Rec | null) => string | null;
  }>>;
  verb: Verb;
  note?: string;
  href: string;
  /** G57: the decision option the user chose (resolving only): the note is then the optional why. */
  option?: { id: string; n: number; label: string };
}

/** A row's decision options, read again through its page's own read. */
interface Resolved {
  title: string;
  detail: string[];
  href: string;
  sends: DecidePlan['sends'];
  /** The card's note field placeholder, when the row names its own. */
  notePlaceholder?: string;
  /** The needed note may be typed on the card: the card is shown without it, and Confirm without one sends nothing. */
  noteOnCard?: boolean;
  /** G57: the numbered rows a decision's dialogue offers (its options, Something else…, Reject); `option` names one. */
  choices?: DialogueRow[];
  /**
   * The note is the answer itself (a consult): the card says "Answer". Sweep 11 (M2): the answer steers a running
   * agent, so it is click-only like every decide; the card opens with it in the note field to check and correct.
   */
  answer?: boolean;
}

type Resolver = (id: string, ctx: ToolContext) => Promise<Resolved | { result: ToolResult }>;

/** Sweep 11 (M2): what the voice says while an answer to an agent waits on the card. */
export const ANSWER_ON_CARD = "I've put your answer on the card; check it and click Send.";
/** The answer card's note field (ui-components 2.516.0): its label and the catalogue's note cap. */
export const ANSWER_LABEL = 'Your answer';
export const ANSWER_MAX = 500;

const notWaiting = (what: string) => ({ result: refused(`That ${what} is not waiting on your decision, or you cannot read it.`) });

/** Access: the requests waiting on the caller (GET /api/access/approvals); the current step is the one decided. */
const accessRequest: Resolver = async (id, ctx) => {
  const read = await readJson<{ items?: Rec[] }>(ctx, '/api/access/approvals');
  if (!read.ok) return { result: readFailure('the requests waiting on you', read.status) };
  const row = (read.body.items ?? []).find((r) => r['id'] === id);
  if (!row) return notWaiting('request');
  const steps = Array.isArray(row['steps']) ? row['steps'] as Rec[] : [];
  const step = steps.find((s) => s['status'] === 'current')?.['step'];
  if (typeof step !== 'number') return notWaiting('request');
  const item = str(dig(row, 'item.title')) ?? 'an item';
  const who = str(dig(row, 'beneficiary.displayName')) ?? str(dig(row, 'requester.displayName')) ?? 'someone';
  const amount = usd(row['requestedUsd']);
  const url = `/api/access/requests/${enc(id)}/steps/${step}/decide`;
  return {
    title: `${item} for ${who}`,
    detail: [`Step ${step}${str(steps.find((s) => s['step'] === step)?.['kind']) ? ` (${String(steps.find((s) => s['step'] === step)!['kind'])})` : ''}.`, ...(amount ? [`Requests ${amount}.`] : [])],
    href: `/access/requests/${enc(id)}`,
    sends: {
      approve: { said: 'Approved', send: (note) => ({ method: 'POST', url, body: { decision: 'approve', ...(note ? { comment: note } : {}) } }) },
      reject: { said: 'Rejected', needsNote: 'A rejection needs a reason; say it as the note.', send: (note) => ({ method: 'POST', url, body: { decision: 'reject', comment: note } }) },
    },
  };
};

/** Access: one standing grant in a review (`<review>/<item>`), from the review's own read; keep or revoke. */
const reviewItem: Resolver = async (id, ctx) => {
  const [reviewId, itemId] = id.split('/');
  if (!reviewId || !itemId) return notWaiting('review item');
  const read = await readJson<{ items?: Rec[]; review?: Rec }>(ctx, `/api/access/reviews/${enc(reviewId)}`);
  if (!read.ok) return { result: read.status === 404 ? notWaiting('review item').result : readFailure('that review', read.status) };
  const row = (read.body.items ?? []).find((r) => r['id'] === itemId);
  if (!row || dig(row, 'can.decide') !== true) return notWaiting('review item');
  const url = `/api/access/reviews/${enc(reviewId)}/items/${enc(itemId)}/decide`;
  const who = str(dig(row, 'user.displayName')) ?? 'someone';
  return {
    title: `${who}'s ${String(row['role'] ?? 'role')} in ${String(row['tenant'] ?? 'the workspace')}`,
    detail: ['Approve keeps the grant; reject revokes it.'],
    href: `/access/reviews/${enc(reviewId)}`,
    sends: {
      approve: { said: 'Kept', send: (note) => ({ method: 'POST', url, body: { decision: 'keep', ...(note ? { comment: note } : {}) } }) },
      reject: { said: 'Revoked', needsNote: 'Revoking needs a reason; say it as the note.', send: (note) => ({ method: 'POST', url, body: { decision: 'revoke', comment: note } }) },
    },
  };
};

/** Pipelines: a step waiting on an approver (GET /api/pipelines/approvals), only for a role the step names. */
const stepApproval: Resolver = async (id, ctx) => {
  const read = await readJson<{ approvals?: Rec[] }>(ctx, '/api/pipelines/approvals');
  if (!read.ok) return { result: readFailure('the approvals', read.status) };
  const row = (read.body.approvals ?? []).find((r) => r['id'] === id);
  if (!row) return notWaiting('approval');
  const roles = Array.isArray(row['requiredRoles']) ? row['requiredRoles'] as string[] : [];
  // The page's own canDecide: a step names the roles that may decide it.
  if (roles.length && !roles.includes(ctx.role) && ctx.role !== 'admin') return { result: refused(`That step is decided by ${roles.join(' or ')}, not your role.`) };
  const url = `/api/pipelines/approvals/${enc(id)}/decide`;
  return {
    title: str(row['title']) ?? str(row['question']) ?? 'the step',
    detail: [...(str(row['question']) && str(row['title']) ? [String(row['question'])] : [])],
    href: '/pipelines/approvals',
    sends: {
      approve: { said: 'Approved', send: (note) => ({ method: 'POST', url, body: { decision: 'approve', note: note ?? null } }) },
      reject: { said: 'Rejected', send: (note) => ({ method: 'POST', url, body: { decision: 'reject', note: note ?? null } }) },
    },
  };
};

/** Work: a pending HITL transaction (GET /api/observability/approvals?status=PENDING); the card shows its amount. */
const hitlApproval: Resolver = async (id, ctx) => {
  const read = await readJson<{ approvals?: Rec[] }>(ctx, `/api/observability/approvals?${qs({ status: 'PENDING' })}`);
  if (!read.ok) return { result: readFailure('the pending approvals', read.status) };
  const row = (read.body.approvals ?? []).find((r) => r['approvalId'] === id);
  if (!row) return notWaiting('transaction');
  const amount = usd(dig(row, 'payload.amount'));
  const url = `/api/observability/approvals/${enc(id)}/decision`;
  return {
    title: str(row['reason']) ?? `the transaction from ${String(row['agentId'] ?? 'an agent')}`,
    detail: [amount ? `Amount: ${amount}.` : 'No amount given.', ...(str(row['agentId']) ? [`Requested by ${String(row['agentId'])}.`] : [])],
    href: '/admin/observability/approvals',
    sends: {
      approve: { said: 'Approved', send: (note) => ({ method: 'POST', url, body: { decision: 'APPROVED', ...(note ? { note } : {}) } }) },
      reject: { said: 'Rejected', send: (note) => ({ method: 'POST', url, body: { decision: 'REJECTED', ...(note ? { note } : {}) } }) },
    },
  };
};

/** Work: an agent change (GET /api/sdlc/changes/:id): decided while it awaits approval, delivered once approved. */
const change: Resolver = async (id, ctx) => {
  const read = await readJson<{ change?: Rec }>(ctx, `/api/sdlc/changes/${enc(id)}`);
  if (!read.ok) return { result: read.status === 404 ? notWaiting('change').result : readFailure('that change', read.status) };
  const c = read.body.change ?? {};
  const status = String(c['status'] ?? '');
  const decidable = status === 'needs_approval' || status === 'changes_requested';
  const url = (verb: string) => `/api/sdlc/changes/${enc(id)}/${verb}`;
  const sends: DecidePlan['sends'] = {};
  // The page's own gate (changesFormat changeActionGate): decide while it awaits approval, deliver once approved.
  // The author is not refused here: the route refuses them and says why (the card is the route's to answer).
  if (decidable) {
    sends.approve = { said: 'Approved', send: (note) => ({ method: 'POST', url: url('decide'), body: { decision: 'approve', ...(note ? { note } : {}) } }) };
    sends.reject = { said: 'Rejected', send: (note) => ({ method: 'POST', url: url('decide'), body: { decision: 'reject', ...(note ? { note } : {}) } }) };
  }
  if (status === 'approved') sends.deliver = { said: 'Delivered', send: () => ({ method: 'POST', url: url('deliver'), body: {} }) };
  if (!Object.keys(sends).length) return { result: refused(`"${str(c['title']) ?? id}" is ${status.replace(/_/g, ' ') || 'not open'}; there is nothing to decide on it.`) };
  return {
    title: `"${str(c['title']) ?? id}"`,
    detail: [`It is ${status.replace(/_/g, ' ')}.`, ...(str(c['repoFullName']) ? [`In ${String(c['repoFullName'])}.`] : []), ...(sends.deliver ? ['Delivering opens its pull request.'] : [])],
    href: `/admin/changes/${enc(id)}`,
    sends,
  };
};

/** Work: a runbook proposal (GET /api/runbooks/proposals/:pid, whose `can_review` is the page's own gate). */
const runbookProposal: Resolver = async (id, ctx) => {
  const read = await readJson<{ proposal?: Rec; runbook?: Rec | null; can_review?: boolean }>(ctx, `/api/runbooks/proposals/${enc(id)}`);
  if (!read.ok) return { result: read.status === 404 ? notWaiting('proposal').result : readFailure('that proposal', read.status) };
  const p = read.body.proposal ?? {};
  if (p['status'] !== 'open' || read.body.can_review !== true) return { result: refused('That proposal is not open for your review (yours, closed, or outside your initiatives).') };
  const title = str(dig(p, 'proposed.title')) ?? str(p['title']) ?? 'the proposal';
  const url = (verb: string) => `/api/runbooks/proposals/${enc(id)}/${verb}`;
  const version = read.body.runbook?.['current_version'];
  const sends: DecidePlan['sends'] = {
    reject: { said: 'Rejected', needsNote: 'A rejection needs a note for the proposer; say it as the note.', send: (note) => ({ method: 'POST', url: url('reject'), body: { note } }) },
  };
  // A new runbook's scope is chosen on its page; an edit is accepted against the version the page shows.
  if (p['kind'] !== 'new' && typeof version === 'number') {
    sends.approve = { said: 'Accepted', send: (note) => ({ method: 'POST', url: url('accept'), body: { expected_version: version, ...(note ? { note } : {}) } }) };
  }
  return {
    title: `"${title}"`,
    detail: [p['kind'] === 'new' ? 'A new runbook: accept it on its page, where its scope is chosen.' : `An edit to version ${String(version ?? '?')}.`],
    href: `/iq/runbooks/proposals/${enc(id)}`,
    sends,
  };
};

/** Work: a pending graph change proposal (GET /api/work/proposals?status=pending). */
const graphProposal: Resolver = async (id, ctx) => {
  const read = await readJson<{ proposals?: Rec[] }>(ctx, `/api/work/proposals?${qs({ status: 'pending' })}`);
  if (!read.ok) return { result: readFailure('the proposals', read.status) };
  const row = (read.body.proposals ?? []).find((r) => r['id'] === id);
  if (!row) return notWaiting('proposal');
  const url = `/api/work/proposals/${enc(id)}/decide`;
  return {
    title: str(row['rationale']) ?? `the ${String(row['kind'] ?? '')} proposal`.replace(/\s+/g, ' '),
    detail: [`${String(row['kind'] ?? 'A change')} on ${String(row['targetType'] ?? 'the graph')}.`],
    href: '/iq/work/changes',
    sends: {
      approve: { said: 'Approved', send: (note) => ({ method: 'POST', url, body: { decision: 'approve', ...(note ? { note } : {}) } }) },
      reject: { said: 'Rejected', send: (note) => ({ method: 'POST', url, body: { decision: 'reject', ...(note ? { note } : {}) } }) },
    },
  };
};

/**
 * `safeLabel` held to `max` characters at a word boundary: a longer text ends at its last whole word within the bound
 * and an ellipsis ("…which tenant goes first…"), never mid-word ("writ") and never with an unclosed quote. A text with
 * no space in its first 60% is cut at the bound instead. The result, ellipsis included, is at most `max` characters.
 */
export function labelAtWord(s: string, max: number): string {
  const full = safeLabel(s, Number.MAX_SAFE_INTEGER);
  if (full.length <= max) return full;
  const room = full.slice(0, Math.max(1, max - 1));
  const space = room.lastIndexOf(' ');
  const cut = space >= Math.floor(max * 0.6) ? room.slice(0, space) : room;
  return `${cut.replace(/[\s,.;:'\u2013\u2014-]+$/, '')}…`;
}

/** Work: a computer's pending consult (GET /api/lab/consults?status=pending); the answer is the user's note, verbatim on the card. */
const consult: Resolver = async (id, ctx) => {
  const read = await readJson<{ consults?: Rec[] }>(ctx, `/api/lab/consults?${qs({ status: 'pending' })}`);
  if (!read.ok) return { result: readFailure('the consults', read.status) };
  const row = (read.body.consults ?? []).find((r) => r['id'] === id);
  if (!row) return notWaiting('consult');
  return {
    // Sweep 11 (L5): the agent's question is agent-written text; the card title holds it to the row-title bound,
    // cut at a word with the ellipsis inside the closing quote (the card wraps and clamps what is left).
    title: `the consult "${labelAtWord(str(row['question']) ?? id, MAX_FIELD_CHARS)}"`,
    detail: [],
    href: '/iq/work',
    sends: { approve: { said: 'Answered', word: 'Answer', needsNote: 'Say the answer as the note.', send: (note) => ({ method: 'POST', url: `/api/lab/consults/${enc(id)}/answer`, body: { answer: note } }) } },
    answer: true,
  };
};

/** Work: a design thread's sign-off (GET /api/designs/:id), while it is still open. */
const design: Resolver = async (id, ctx) => {
  const read = await readJson<Rec>(ctx, `/api/designs/${enc(id)}`);
  if (!read.ok) return { result: read.status === 404 ? notWaiting('design').result : readFailure('that design', read.status) };
  const status = String(read.body['status'] ?? '');
  if (['approved', 'rejected', 'superseded'].includes(status)) return { result: refused(`That design is already ${status}.`) };
  const url = `/api/designs/${enc(id)}/signoff`;
  return {
    title: `the "${str(read.body['title']) ?? id}" design`,
    detail: [`It is ${status.replace(/_/g, ' ')}${str(read.body['orgProjectName']) ? `, on ${String(read.body['orgProjectName'])}` : ''}.`],
    href: `/iq/designs/${enc(id)}`,
    sends: {
      approve: { said: 'Signed off', send: () => ({ method: 'POST', url, body: { decision: 'approve' } }) },
      reject: { said: 'Rejected', send: () => ({ method: 'POST', url, body: { decision: 'reject' } }) },
    },
  };
};

/**
 * Work: a waiting decision (GET /api/graph/decisions/:id, G54), resolved or
 * rejected with the outcome and why as the note (the route's `rationale`, at
 * most 500 characters, required). The page's own gate: open or escalated, and
 * `viewerMayDecide` (the decider, the initiative's owner, an org-leader); the
 * route checks both again.
 */
const decisionRecord: Resolver = async (id, ctx) => {
  const read = await readJson<Rec>(ctx, `/api/graph/decisions/${enc(id)}`);
  if (!read.ok) return { result: read.status === 404 ? notWaiting('decision').result : readFailure('that decision', read.status) };
  const d = read.body;
  const status = String(d['status'] ?? '');
  const topic = str(d['topic']) ?? id;
  if (status !== 'open' && status !== 'escalated') return { result: refused(`"${topic}" is already ${status === 'resolved' ? 'decided' : status || 'settled'}.`) };
  const people = Array.isArray(d['participants']) ? d['participants'] as Rec[] : [];
  const decider = str(people.find((p) => String(p['role'] ?? '').toLowerCase() === 'decider')?.['name']);
  if (d['viewerMayDecide'] === false) return { result: refused(`"${topic}" is waiting on ${decider ?? 'its decider'}, not you; only the decider, the initiative's owner or an org-leader can decide it.`) };
  const url = `/api/graph/decisions/${enc(id)}/decide`;
  const needsNote = 'A decision needs its outcome and why; say it as the note, or choose one of its options.';
  const options = Array.isArray(d['options']) ? (d['options'] as Rec[]).flatMap((o) => {
    const oid = str(o['id']); const label = str(o['label']);
    return oid && label ? [{ id: oid, label }] : [];
  }) : [];
  return {
    title: `"${topic}"`,
    detail: [`It is ${status}${decider ? `; ${decider} decides` : ''}.`],
    href: `/iq/decisions/${enc(id)}`,
    notePlaceholder: 'What was decided, and why (needed)',
    noteOnCard: true,
    choices: dialogueRows(options),
    sends: {
      // G57: with an option the route records its label (and ", because <note>"); without one the note is the outcome.
      approve: { said: 'Resolved', word: 'Resolve', needsNote, send: (note, optionId) => ({ method: 'POST', url, body: optionId
        ? { optionId, outcome: 'resolved', ...(note ? { rationale: note } : {}) } : { outcome: 'resolved', rationale: note } }),
        after: unblockedLine },
      reject: { said: 'Rejected', word: 'Reject', needsNote, send: (note) => ({ method: 'POST', url, body: { outcome: 'rejected', rationale: note } }) },
    },
  };
};

/**
 * Deciding a decision settles the work it held up (the route's `heldWork`):
 * with exactly one item unblocked the say line names it, in the same sentence
 * ("…; "Tenant-by-tenant cutover runbook with rollback" is unblocked"). Several
 * are left to the record, so the line stays one short sentence.
 */
export function unblockedLine(body: Rec | null): string | null {
  const held = Array.isArray(body?.['heldWork']) ? body['heldWork'] as Rec[] : [];
  const unblocked = held.filter((w) => w['blocked'] === false && typeof w['title'] === 'string' && w['title']);
  return unblocked.length === 1 ? `"${String(unblocked[0]!['title'])}" is unblocked` : null;
}

/** Assessment: a finished draft (GET /api/assessment/drafts/:runId) not yet decided: accept writes it into the team, discard drops it. */
const draft: Resolver = async (id, ctx) => {
  const read = await readJson<Rec>(ctx, `/api/assessment/drafts/${enc(id)}`);
  if (!read.ok) return { result: read.status === 404 ? notWaiting('draft').result : readFailure('that draft', read.status) };
  const d = read.body;
  if (d['phase'] !== 'completed') return { result: refused(`That draft is ${String(d['phase'] ?? 'not finished')}; decide it once it has finished.`) };
  if (d['decision'] != null) return { result: refused(`That draft was already ${String(d['decision'])}.`) };
  const url = (verb: string) => `/api/assessment/drafts/${enc(id)}/${verb}`;
  return {
    title: `the ${String(d['kind'] ?? '').replace(/[-_]/g, ' ')} draft`.replace(/\s+/g, ' '),
    detail: ['Accept writes it into the team; discard drops it.'],
    href: typeof d['teamId'] === 'string' ? `/assessment/teams/${enc(d['teamId'])}` : '/assessment/teams',
    sends: {
      approve: { said: 'Accepted', send: () => ({ method: 'POST', url: url('accept'), body: typeof d['revision'] === 'number' ? { baseRevision: d['revision'] } : {} }) },
      reject: { said: 'Discarded', send: () => ({ method: 'POST', url: url('discard'), body: {} }) },
    },
  };
};

/** The resolver per tenant and ref kind (the catalogue's DECIDE_ACTIONS has the same keys; the drift test holds them together). */
export const DECIDE_RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  orgiq: { 'hitl-approval': hitlApproval, change, 'runbook-proposal': runbookProposal, proposal: graphProposal, consult, design, decision: decisionRecord },
  assessment: { draft },
  pipelines: { approval: stepApproval },
  access: { approval: accessRequest, request: accessRequest, 'review-item': reviewItem },
};

const VERB_WORD: Readonly<Record<Verb, string>> = { approve: 'Approve', reject: 'Reject', deliver: 'Deliver' };

const planDecide: VoiceToolPlanner = async (args, ctx) => {
  let ref = String(args['ref']).trim();
  // G21: a position among the rows the page in view shows.
  if (args['scope'] === 'this-page') {
    const hit = pageRowNamed(ctx, ref);
    if ('result' in hit) return hit;
    ref = hit.row.ref;
  } else if (/^\d{1,2}$/.test(ref)) {
    const strict = positionRefusal(ctx, ref);
    if (strict) return { result: strict };
    const kept = ctx.results?.find(ref);
    if (!kept) return { result: refused(`There is no row ${ref} in the last result. List what is waiting first.`) };
    ref = kept.ref;
  }
  const parsed = parseRef(ref);
  if (!parsed) return { result: refused('Name the row by the ref a result gave, such as "approval:<id>", or its position. List what is waiting first.') };
  const kinds = DECIDE_ACTIONS[ctx.tenant] ?? {};
  const resolve = DECIDE_RESOLVERS[ctx.tenant]?.[parsed.kind];
  if (!(parsed.kind in kinds) || !resolve) return { result: refused(`A ${parsed.kind.replace(/-/g, ' ')} is not decided by voice in this workspace.`) };
  let verb = verbOf(String(args['decision']));
  const saidOption = args['option'] == null || args['option'] === '' ? null : args['option'];
  if (saidOption !== null && parsed.kind !== 'decision') return { result: refused(`A ${parsed.kind.replace(/-/g, ' ')} has no numbered options; say approve or reject.`) };
  const action = kinds[parsed.kind]![verb];
  if (action === undefined) return { result: refused(`A ${parsed.kind.replace(/-/g, ' ')} cannot be "${String(args['decision'])}".`) };
  // The page button's own action, before any request (prepareToolCall cannot: it depends on the ref and the decision).
  if (action && !ctx.can(action)) return { result: refused(`I can't ${String(args['decision'])} that with your role.`) };
  const row = await resolve(parsed.id, ctx);
  if ('result' in row) return row;
  // G57: the option the user named, by the dialogue's numbering: an option resolves with it, Something else is a
  // resolve whose note is the outcome, Reject is a reject.
  let option: DecidePlan['option'];
  if (saidOption !== null) {
    const hit = matchDialogueRow(row.choices ?? [], typeof saidOption === 'number' ? saidOption : String(saidOption));
    if ('error' in hit) {
      const rows = row.choices ?? [];
      return { result: refused(`${row.title} has no option "${String(saidOption)}"; choose 1 to ${rows.length} as its page numbers them.`,
        { options: rows.map((r) => `${r.n}. ${r.label}`) }) };
    }
    if (hit.row.kind === 'reject') verb = 'reject';
    else if (verb === 'reject') return { result: refused(`${row.title}: a rejection takes no option. Say reject with why, or decide option ${hit.row.n}.`) };
    else if (hit.row.kind === 'option') option = { id: hit.row.id, n: hit.row.n, label: hit.row.label };
  }
  const chosen = row.sends[verb];
  if (!chosen) return { result: refused(`${row.title} cannot be ${verb === 'approve' ? 'approved' : verb === 'reject' ? 'rejected' : 'delivered'} now; ${row.detail[0] ?? 'see its page'}`) };
  const note = typeof args['note'] === 'string' && args['note'].trim() ? args['note'].trim() : undefined;
  if (chosen.needsNote && !note && verb !== 'reject' && !row.noteOnCard && !option) return { result: refused(chosen.needsNote) };
  const both = !!row.sends.approve && !!row.sends.reject && verb !== 'deliver';
  const plan: DecidePlan = { kind: parsed.kind, id: parsed.id, title: row.title, sends: row.sends, verb, href: row.href, ...(note ? { note } : {}), ...(option ? { option } : {}) };
  const card: ConfirmPlan = {
    title: `${chosen.word ?? VERB_WORD[verb]} ${row.title}`,
    // The chosen option first (G57), then what the user said as its why.
    // An answer is not repeated as a line: it is the note field's text.
    detail: [...row.detail, ...(option ? [`Option ${option.n}: ${option.label}`] : []), ...(note && !row.answer ? [`${option ? 'Why' : 'Note'}: ${note}`] : [])],
    // Sweep 11 (M2): an answer to an agent is what the model heard, and it directs a running agent. It stays click-only
    // like every decide: the card opens with the answer in its editable note field (ui-components 2.516.0), no
    // toggle, the button says Send, the voice says to check it and click, and the edited text is what is sent.
    ...(row.answer && note ? {
      fields: { decision: 'approve' as const },
      line: ANSWER_ON_CARD,
      card: { noteDefault: note, noteLabel: ANSWER_LABEL, noteMaxLength: ANSWER_MAX, confirmLabel: 'Send', hideDecisionToggle: true, clickOnly: true },
      // A button named for one way (Resolve / Reject) never sits beside a toggle that could send the other: the
      // toggle is hidden and the note stays; to go the other way the user cancels and says it.
    } : chosen.word ? { card: { confirmLabel: chosen.word, ...(both ? { hideDecisionToggle: true } : {}) } }
      // The toggle shows (both ways open, no one-way word): the button follows it, Approve or Reject (2.517.0).
      // Click-only like every decide (M2), so the hint is the library's "Check it, then click <label>", following it too.
      : both ? { card: { confirmLabels: { approve: row.sends.approve!.word ?? VERB_WORD.approve, reject: row.sends.reject!.word ?? VERB_WORD.reject }, clickOnly: true } } : {}),
    // Both ways open: the library's toggle and note, starting where the user said; Confirm answers { decision, note }.
    ...(both ? { fields: { decision: verb === 'reject' ? 'reject' : 'approve', notePlaceholder: option ? 'Why (optional)' : row.notePlaceholder ?? (row.sends.reject?.needsNote ? 'Reason (needed to reject)' : 'Note (optional)') } } : {}),
    data: plan,
  };
  return { plan: card };
};

/** The route's refusal as the route said it: the author, an already decided row, a role the route refuses. */
function decideRefusal(status: number, body: Rec | null, title: string): ToolResult {
  const error = str(body?.['error']);
  if (status === 0) return failed('Could not reach the server; nothing was decided.', { code: 'not-connected' });
  if (body?.['gate'] === 'self-approval') return refused(`Not decided: ${error ?? 'you asked for this, so someone else must decide it'}.`);
  if (status === 401 || status === 403) return refused(`Not decided: ${error && !/^forbidden$/i.test(error) ? error : 'your role cannot decide that'}.`);
  if (status === 404) return refused(`${title} is no longer waiting; it may already be decided.`);
  if (status === 409) return refused(`Not decided: ${error ?? 'it was already decided'}.`);
  if (status === 400 || status === 422) return refused(`Not decided: ${error ?? 'the server refused it'}.`);
  return failed(`${title} could not be decided (HTTP ${status})${error ? `: ${error}` : ''}.`, { code: `http-${status}`, ...(str(body?.['gate']) ? { gate: str(body?.['gate']) } : {}) });
}

const runDecide: VoiceToolRunner = async (_args, ctx, planned, answer?: CardAnswer) => {
  const plan = planned as DecidePlan | undefined;
  if (!plan?.sends) return refused('A decision is sent only after the user confirms its card.');
  // The card's toggle and note win over the spoken arguments when the user clicked.
  const verb: Verb = answer && plan.verb !== 'deliver' ? answer.decision : plan.verb;
  // A consult's answer is the card's note as edited (it opened with the dictated one): emptied, nothing is sent.
  const note = answer ? (answer.note.trim() || (plan.kind === 'consult' ? undefined : plan.note)) : plan.note;
  const chosen = plan.sends[verb];
  if (!chosen && plan.kind === 'consult') return refused('An agent\'s question is answered, not rejected; nothing was sent.');
  if (!chosen) return refused(`${plan.title} cannot be ${verb === 'reject' ? 'rejected' : 'approved'} by voice.`);
  const action = DECIDE_ACTIONS[ctx.tenant]?.[plan.kind]?.[verb];
  if (action && !ctx.can(action)) return refused(`I can't ${verb} that with your role.`);
  // G57: a chosen option holds only while resolving; flipped to reject on the card, the note is the why and is needed.
  const option = verb === 'approve' ? plan.option : undefined;
  if (chosen.needsNote && !note && !option) return refused(`${chosen.needsNote} Nothing was decided.`);
  const send = chosen.send(note, option?.id);
  return once(ctx, `${send.method} ${send.url} ${verb}`, async () => {
    let res: Response;
    try {
      res = await ctx.fetch(send.url, { method: send.method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(send.body) });
    } catch {
      return failed('Could not reach the server; nothing was decided.');
    }
    const body = await res.json().catch(() => null) as Rec | null;
    if (!res.ok) return decideRefusal(res.status, body, plan.title);
    const prUrl = str(body?.['prUrl']);
    const also = chosen.after?.(body) ?? null;
    const line = `${chosen.said}: ${plan.title}${option ? ` (${optionOutcome(option.label, note ?? '')})` : ''}${also ? `; ${also}` : ''}`;
    const out = done('decided', { ref: `${plan.kind}:${plan.id}`, decision: verb, title: plan.title, href: plan.href, ...(note ? { note } : {}), ...(option ? { option: option.label } : {}), ...(prUrl ? { delivered: true } : {}) }, line);
    // A consult's answer is said back as the words sent (coverage, 10 November), not the long question.
    if (plan.kind === 'consult' && note) return { ...out, output: { ...out.output, say: sayLine(`Answered the agent: "${note}"`) } };
    // The strip's summary is capped; the spoken line keeps the unblocked story whole (still one sentence).
    return also ? { ...out, output: { ...out.output, say: `${line}.` } } : out;
  }, () => done('decided', { ref: `${plan.kind}:${plan.id}`, decision: verb, title: plan.title, alreadyDecided: true }, `${plan.title} was already decided; nothing was sent again`));
};

// ── create and update (V2-11) ───────────────────────────────────────────────
//
// create { kind, fields }: one field set per kind (catalogue CREATE_FIELDS),
// the form's submit route and body, its Cedar action first. Names the user
// said resolve through the kind's own list read (findByName); a comment's
// work item is a ref a result handed out. Text the user dictated (a title, a
// comment, a justification) is sent as said and shown verbatim on the card.
// An access request's card is the route's own preview (approvers, conflicts,
// a refusal ends it with no card).
//
// update { ref, fields }: one field per ref kind (catalogue UPDATE_ACTIONS),
// the row read again through its kind's list (a ref must be a row the
// persona's own read returns), the page button's route. A channel is joined
// only with PostMessage (the route's own gate), left with the Social grant.

interface ActPlan {
  key: string; send: Send; done: string; result: Record<string, unknown>; href?: string;
  /** Where the route's answer names the record it made (an access request's `id`): spoken back as `id` (G27). */
  idAt?: string;
  /** A meeting (G25) sends no request of its own: the time and the room go back to the thread it answers. */
  meeting?: MeetingPlan;
  /** Where the route's answer names the page of what it made (a document's `document.href`): opened on success (G55). */
  openAt?: string;
}

/** "this-page", "this initiative", "here", or nothing: the initiative whose page is open (G55). */
const THIS_PAGE = /^(?:this[- ]page|this(?: initiative| one)?|here|the one in view|current)$/i;

/** The initiative a document, whiteboard or deck goes in: the one named, or the one in view. */
async function initiativeOf(ctx: ToolContext, said: unknown): Promise<{ id: string; title: string } | { result: ToolResult }> {
  const name = str(said);
  if (!name || THIS_PAGE.test(name)) {
    const record = ctx.page?.()?.record ?? null;
    const id = record ? /^initiative:(.+)$/.exec(record.ref)?.[1] : undefined;
    if (!record || !id) return { result: refused('Name the initiative, or open its page and ask again.', { code: 'not-on-this-page' }) };
    return { id, title: record.title };
  }
  const found = await findByName(ctx, 'initiative', name);
  if ('result' in found) return found;
  return { id: found.row.id, title: found.row.title };
}

/** G25: the initiative's huddle room (the meeting-rooms lobby) and a time; there is no calendar object to create. */
interface MeetingPlan { initiativeId: string; initiative: string; time: string; href: string; reply: { channel: string; to: string; replyTo?: { messageId: string; author: string; text: string; timestamp?: string } } | null }

/** What the voice says about a meeting: the portal keeps no calendar, so nothing is booked beyond the room. */
export const NO_CALENDAR = 'There is no calendar in the portal, so nothing is booked; the room is the initiative\'s huddle, started from its page.';

/** The justification an access request filed by voice carries outside Access: the user's own words, at most 200 characters. */
export function voiceJustification(tenant: string, said: string): string {
  return `Requested by voice in the ${tenant} workspace: ${said.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

const MAX_CREATE = { justification: JUSTIFICATION_MIN, reason: DELEGATION_REASON_MIN };

/** The field set check: what a kind needs, nothing it does not take. */
function fieldProblem(kind: string, fields: Rec): string | null {
  const set = CREATE_FIELDS[kind];
  if (!set) return `There is no "${kind}" to create here.`;
  const [required, optional] = set;
  const extra = Object.keys(fields).filter((f) => !required.includes(f) && !optional.includes(f));
  if (extra.length) return `A ${kind.replace(/-/g, ' ')} takes ${[...required, ...optional].join(', ')}; not ${extra.join(', ')}.`;
  const missing = required.filter((f) => fields[f] === undefined);
  return missing.length ? `A ${kind.replace(/-/g, ' ')} needs ${missing.join(' and ')}.` : null;
}

const isoDay = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);

/**
 * Sweep 11 (M1): the server holds every work write to the initiative's own people (owner, contributor or an
 * org-wide role). The initiative's read says whether this session is one (`canWriteWork`), so the voice refuses
 * before a card, with the access next step (the initiative's membership item), rather than after a click.
 * A failed read refuses nothing: the route still decides.
 */
async function offInitiative(ctx: ToolContext, projectId: string, title?: string): Promise<{ result: ToolResult } | null> {
  const read = await readJson<{ canWriteWork?: unknown; name?: unknown }>(ctx, `/api/graph/projects/${enc(projectId)}`);
  if (!read.ok || read.body.canWriteWork !== false) return null;
  const name = title ?? (typeof read.body.name === 'string' ? read.body.name : 'this initiative');
  return { result: refused(`Only the people on ${name} (its owner and contributors) change its work, and you are not one of them.`, { code: 'not-on-initiative', requestItemId: `initiative:${projectId}` }) };
}

async function planCreateKind(kind: string, f: Rec, ctx: ToolContext): Promise<{ plan: ConfirmPlan } | { result: ToolResult }> {
  const card = (title: string, detail: string[], act: ActPlan) => ({ plan: { title, detail, data: act } satisfies ConfirmPlan });
  switch (kind) {
    case 'work-item': {
      // Coverage (10 November): on an initiative's page "add a bug: …" files it on the initiative in view.
      const where = await initiativeOf(ctx, f['initiative']);
      if ('result' in where) return where;
      const off = await offInitiative(ctx, where.id, where.title);
      if (off) return off;
      const type = String(f['type'] ?? 'story');
      const body = { projectId: where.id, type, title: String(f['title']).trim(), priority: 'medium' };
      return card(`Create a ${type} on ${where.title}`, [`"${body.title}"`, 'Priority medium; it starts open.'],
        { key: `POST /api/graph/work-items ${JSON.stringify(body)}`, send: { method: 'POST', url: '/api/graph/work-items', body }, done: `Created the ${type} "${body.title}" on ${where.title}`, result: { kind: 'work-item', title: body.title }, href: `/iq/projects/${enc(where.id)}` });
    }
    case 'comment': {
      const on = String(f['on']).trim();
      if (!/^\d{1,2}$/.test(on) && !parseRef(on)) return { result: refused('Name the work item by the ref a result gave, or its position. List the work items first.') };
      const found = await findByName(ctx, 'work-item', on);
      if ('result' in found) return found;
      const text = String(f['text']).trim();
      const url = `/api/graph/work-items/${enc(found.row.id)}/comments`;
      return card(`Comment on "${found.row.title}"`, [text, 'Everyone on the initiative reads it.'],
        { key: `POST ${url} ${text}`, send: { method: 'POST', url, body: { body: text } }, done: `Commented on "${found.row.title}"`, result: { kind: 'comment', on: `work-item:${found.row.id}` }, ...(found.row.href ? { href: found.row.href } : {}) });
    }
    case 'saved-search': {
      const body = { name: String(f['name']).trim(), query: String(f['query']).trim(), scope: 'workspace' };
      return card(`Save the search "${body.name}"`, [`For "${body.query}" across the workspace.`],
        { key: `POST /api/saved-searches ${JSON.stringify(body)}`, send: { method: 'POST', url: '/api/saved-searches', body }, done: `Saved "${body.name}"`, result: { kind: 'saved-search', name: body.name }, href: '/iq/search' });
    }
    case 'sprint': {
      const startsOn = isoDay(f['startsOn']); const endsOn = isoDay(f['endsOn']);
      if (!startsOn || !endsOn || endsOn <= startsOn) return { result: refused('A sprint needs a first and a last day as YYYY-MM-DD, the last after the first.') };
      const found = await findByName(ctx, 'initiative', String(f['initiative']));
      if ('result' in found) return found;
      const body = { initiativeId: found.row.id, name: String(f['name']).trim(), startsOn, endsOn };
      return card(`Start the sprint "${body.name}" on ${found.row.title}`, [`${startsOn} to ${endsOn}; it starts planned.`],
        { key: `POST /api/sprints ${JSON.stringify(body)}`, send: { method: 'POST', url: '/api/sprints', body }, done: `Created the sprint "${body.name}"`, result: { kind: 'sprint', name: body.name }, href: '/iq/projects?lens=sprints' });
    }
    case 'document':
    case 'whiteboard': {
      // G55/G56: the Docs tab's New › Document / Whiteboard. Its own read answers whether this caller writes pages here
      // (the initiative's owner, a contributor or an org-wide role); the route holds them to it again.
      const where = await initiativeOf(ctx, f['initiative']);
      if ('result' in where) return where;
      const url = `/api/graph/projects/${enc(where.id)}/workspace-documents`;
      const read = await readJson<{ canWrite?: unknown }>(ctx, url);
      if (!read.ok) return { result: readFailure(`the documents of ${where.title}`, read.status) };
      if (read.body.canWrite !== true) return { result: refused(`Only the people on ${where.title} (its owner and contributors) write pages there.`, { code: 'not-on-initiative' }) };
      const board = kind === 'whiteboard';
      const noun = board ? 'whiteboard' : 'page';
      const title = (str(f['title']) ?? (board ? 'Untitled whiteboard' : 'Untitled page')).slice(0, 200);
      const body = { title, kind: board ? 'whiteboard' : 'page' };
      return card(`Create the ${noun} "${title}" in ${where.title}`, [board ? 'A blank canvas; it opens so you can sketch on it.' : 'A blank page; it opens so you can write it.', 'Everyone who reads the initiative can read it.'],
        { key: `POST ${url} ${JSON.stringify(body)}`, send: { method: 'POST', url, body }, done: `Created the ${noun} "${title}"`, result: { kind, title, initiative: where.title }, href: `/iq/projects/${enc(where.id)}?tab=docs`, openAt: 'document.href' });
    }
    case 'deck': {
      // create { kind: 'deck' } is queue_work's deck by another name (G55): the same planner, card, route and runner.
      const initiative = str(f['initiative']);
      const here = !initiative || THIS_PAGE.test(initiative);
      const focus = str(f['focus']);
      const planned = await WORK_PLANNERS['queue_work']!({ kind: 'deck', target: here ? 'this initiative' : initiative!, ...(here ? { scope: 'this-page' } : {}), ...(focus ? { focus } : {}) }, ctx);
      return planned ?? { result: refused('Nothing was planned for that deck.') };
    }
    case 'channel':
    case 'team':
    case 'room': {
      const name = String(f['name']).trim().replace(/^#/, '');
      const priv = f['privacy'] === 'private';
      const description = str(f['description']);
      const body = kind === 'channel'
        ? { name, ...(description ? { description } : {}), privacy: priv ? 'private' : 'public' }
        : { name, ...(description ? { description } : {}), visibility: priv ? 'private' : 'org' };
      const url = `/api/social/${kind}s`;
      const label = kind === 'channel' ? channelTag(name) : `the ${name} ${kind}`;
      return card(`Create ${label}`, [priv ? 'Private: only the people you add see it.' : 'Open to everyone in Social.', ...(description ? [description] : [])],
        { key: `POST ${url} ${name.toLowerCase()}`, send: { method: 'POST', url, body }, done: `Created ${label}`, result: { kind, name }, href: kind === 'channel' ? '/social/channels' : kind === 'team' ? '/social/teams' : '/social/rooms' });
    }
    case 'meeting': {
      const found = await findByName(ctx, 'initiative', String(f['initiative']));
      if ('result' in found) return found;
      const time = String(f['time']).replace(/\s+/g, ' ').trim().slice(0, 40);
      const href = `/iq/projects/${enc(found.row.id)}`;
      let reply: MeetingPlan['reply'] = null;
      if (f['thread'] != null) {
        const item = ctx.inbox?.find(String(f['thread'])) ?? null;
        if (!item?.channel) return { result: refused('There is no inbound message with that ref to answer; pass the ref the portal gave ("message:<id>"), or leave thread out.') };
        if (!ctx.social) return { result: socialGrantRefusal(ctx, 'The reply goes through Social, which this session cannot reach.') };
        reply = { channel: item.channel, to: item.sender || 'them', ...(item.kind === 'message' ? { replyTo: { messageId: item.id, author: item.sender || 'Unknown', text: item.text.slice(0, 280), timestamp: new Date(item.at).toISOString() } } : {}) };
      }
      const meeting: MeetingPlan = { initiativeId: found.row.id, initiative: found.row.title, time, href, reply };
      return card(`Meet at ${time} in the ${found.row.title} huddle`, [
        reply ? `Tells ${reply.to}, in your conversation: the time and the room.` : 'Nobody is told: name the message it answers to send them the time.',
        NO_CALENDAR,
      ], { key: `meeting ${found.row.id} ${time} ${reply?.channel ?? ''}`, send: { method: 'POST', url: '', body: {} }, done: `Meeting at ${time} in the ${found.row.title} huddle`, result: { kind: 'meeting', at: time, room: `${found.row.title} huddle`, calendar: false }, href, meeting });
    }
    case 'access-request': {
      if (ctx.tenant !== 'access') return planQuickAccessRequest(ctx, f, card);
      if (f['duration'] == null) return { result: refused('Say how long: 8 hours, 24 hours, 7 days or 30 days.') };
      const justification = String(f['justification']).trim();
      if (justification.length < MAX_CREATE.justification) return { result: refused(`Say why in at least ${JUSTIFICATION_MIN} characters; the approvers read it.`) };
      const found = await findByName(ctx, 'catalog-item', String(f['item']));
      if ('result' in found) return found;
      const duration = String(f['duration']);
      // The route's own preview: who approves, what conflicts, or why it would be refused (it writes nothing).
      let res: Response;
      try {
        res = await ctx.fetch('/api/access/requests/preview', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: found.row.id, duration }) });
      } catch { return { result: failed('Could not reach the server for the request preview.') }; }
      const preview = await res.json().catch(() => null) as Rec | null;
      if (!res.ok) return { result: res.status === 403 ? refused("I can't file access requests with your role.") : refused(`Not filed: ${str(preview?.['error']) ?? `the preview answered ${res.status}`}.`) };
      const refusal = preview?.['refusal'] as Rec | null | undefined;
      if (refusal) return { result: refused(`Not filed: ${str(refusal['error']) ?? str(refusal['message']) ?? 'the request would be refused'}.`, { ...(str(refusal['requestId']) ? { existing: `request:${String(refusal['requestId'])}` } : {}) }) };
      const steps = Array.isArray(preview?.['steps']) ? preview!['steps'] as Rec[] : [];
      const approvers = steps.map((s) => `step ${String(s['step'])}: ${String(s['kind'] ?? 'approver')}${Array.isArray(s['eligible']) ? ` (${(s['eligible'] as Rec[]).length} can decide)` : ''}`);
      const sod = str(dig(preview, 'sod.verdict'));
      if (sod === 'block') return { result: refused('Not filed: it conflicts with access you hold (separation of duties); the request page shows the conflict.') };
      const body = { itemId: found.row.id, justification, duration };
      return card(`Request ${found.row.title} for ${duration}`, [justification, ...(approvers.length ? [`Approvers: ${approvers.join('; ')}.`] : []), ...(sod && sod !== 'clear' ? [`Separation of duties: ${sod}.`] : [])],
        { key: `POST /api/access/requests ${found.row.id} ${duration}`, send: { method: 'POST', url: '/api/access/requests', body }, done: `Requested ${found.row.title}`, result: { kind: 'access-request', item: found.row.title }, href: '/access/requests' });
    }
    case 'delegation': {
      const reason = String(f['reason']).trim();
      if (reason.length < MAX_CREATE.reason) return { result: refused(`Say why in at least ${DELEGATION_REASON_MIN} characters; it is kept in the audit trail.`) };
      const window = DELEGATION_WINDOWS.find((w) => w.value === f['window']);
      if (!window) return { result: refused('Delegate for 1 day, 3 days, a week or two weeks.') };
      const read = await readJson<{ items?: Array<{ id: string; displayName: string }> }>(ctx, '/api/access/delegates');
      if (!read.ok) return { result: readFailure('who you can delegate to', read.status) };
      const people = (read.body.items ?? []).filter((p) => p && typeof p.id === 'string');
      const hits = matchByName(people, (p) => p.displayName, String(f['delegate']));
      if (!hits.length) return { result: refused(`No one called "${String(f['delegate'])}" can decide access for you.`) };
      if (hits.length > 1) return { result: ambiguous(`Several people match "${String(f['delegate'])}". Ask which one.`, hits.map((p) => ({ name: p.displayName }))) };
      const who = hits[0]!;
      return card(`Delegate your approvals to ${who.displayName} for ${window.label}`, [reason, 'They decide the requests waiting on you until it ends; you can end it early.'],
        { key: `POST /api/access/delegations ${who.id} ${window.value}`, send: { method: 'POST', url: '/api/access/delegations', body: { delegateId: who.id, window: window.value, reason } }, done: `Delegated to ${who.displayName}`, result: { kind: 'delegation', to: who.displayName }, href: '/access/settings' });
    }
    default:
      return { result: refused(`There is no "${kind}" to create here.`) };
  }
}

const planCreate: VoiceToolPlanner = async (args, ctx) => {
  const kind = String(args['kind']);
  const kinds = CREATE_ACTIONS[ctx.tenant] ?? {};
  if (!(kind in kinds)) return { result: refused(`A ${kind.replace(/-/g, ' ')} is not created by voice in this workspace.`) };
  const action = kinds[kind];
  if (action && !ctx.can(action)) return { result: refused(`I can't create ${kind.replace(/-/g, ' ')}s with your role.`) };
  const fields = (args['fields'] as Rec | undefined) ?? {};
  const problem = fieldProblem(kind, fields);
  if (problem) return { result: refused(problem) };
  return planCreateKind(kind, fields, ctx);
};

/** The delegation window becomes the page's own times only when it is sent (delegationBody), so a slow card never starts it late. */
function sendable(act: ActPlan, now: number): Send {
  if (act.send.url !== '/api/access/delegations') return act.send;
  const b = act.send.body as { delegateId: string; window: string; reason: string };
  return { ...act.send, body: delegationBody({ delegateId: b.delegateId, window: b.window, reason: b.reason }, now) };
}

async function act(ctx: ToolContext, plan: ActPlan, verb: string): Promise<ToolResult> {
  return once(ctx, plan.key, async () => {
    const send = sendable(plan, ctx.now().getTime());
    let res: Response;
    try {
      res = await ctx.fetch(send.url, { method: send.method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(send.body) });
    } catch {
      return failed(`Could not reach the server; nothing was ${verb}.`);
    }
    const body = await res.json().catch(() => null) as Rec | null;
    if (!res.ok) {
      const error = str(body?.['error']);
      if (res.status === 401 || res.status === 403) return refused(`Not ${verb}: ${error && !/^forbidden$/i.test(error) ? error : 'your role cannot do that'}.`);
      if (res.status === 404) return refused(`Not ${verb}: it is gone, or you can no longer reach it.`);
      if (res.status === 400 || res.status === 409 || res.status === 422) return refused(`Not ${verb}: ${error ?? `the server refused it (${res.status})`}.`);
      return failed(`Not ${verb} (HTTP ${res.status})${error ? `: ${error}` : ''}.`, { code: `http-${res.status}`, ...(str(body?.['gate']) ? { gate: str(body?.['gate']) } : {}) });
    }
    const id = plan.idAt ? str(dig(body, plan.idAt)) : undefined;
    // G55: a page or a whiteboard opens in its editor once made (the route's own link, only inside the portal).
    const opened = plan.openAt ? str(dig(body, plan.openAt)) : undefined;
    if (opened && localHref(opened)) {
      ctx.navigate(opened);
      return done('created', { ...plan.result, href: opened, opened: true, stop: true, say: `${plan.done}; it is open.` }, `${plan.done}; opened`);
    }
    return done(verb === 'created' ? 'created' : 'updated', { ...plan.result, ...(plan.href ? { href: plan.href } : {}), ...(id ? { id, say: `${plan.done}: request ${id}. I'll tell you when it is decided.` } : {}) },
      id ? `${plan.done} (${id})` : plan.done);
  }, () => done(verb === 'created' ? 'created' : 'updated', { ...plan.result, already: true }, `${plan.done} already; nothing was sent again`));
}

const runCreate: VoiceToolRunner = async (_args, ctx, planned) => {
  // create { kind: 'deck' } planned through queue_work's planner: its runner sends it and follows it (G55).
  if (planned && typeof planned === 'object' && 'post' in planned && (planned as { kind?: unknown }).kind === 'deck') return WORK_RUNNERS['queue_work']!(_args, ctx, planned);
  const plan = planned as ActPlan | undefined;
  if (!plan?.send) return refused('Nothing is created until the user confirms its card.');
  if (plan.meeting) return runMeeting(ctx, plan, plan.meeting);
  return act(ctx, plan, 'created');
};

/**
 * G27: outside Access, the request a refusal named, filed through the quick route (the Access tenant's own
 * fileRequest: the same chain, refusals and approvers' bells), which takes only this workspace's items and the
 * Social plane's own request item. One card; the user's words are the justification.
 */
async function planQuickAccessRequest(ctx: ToolContext, f: Rec, card: (title: string, detail: string[], act: ActPlan) => { plan: ConfirmPlan }): Promise<{ plan: ConfirmPlan } | { result: ToolResult }> {
  const item = String(f['item']).trim();
  if (!/^[a-z][a-z-]*:[A-Za-z0-9:._-]{1,200}$/.test(item)) return { result: refused('Pass the item exactly as the refusal named it (its requestItemId, such as "role:social:moderator").') };
  const said = String(f['justification']).trim();
  if (said.length < 3) return { result: refused('Ask the user why they need it, in a few words; the approvers read it.') };
  const duration = typeof f['duration'] === 'string' ? f['duration'] : '7d';
  // An open request for the same item is the route's own 409; reading it first keeps the card honest.
  const mine = await readJson<{ items?: Array<{ id: string; status: string }> }>(ctx, `/api/access-requests/mine?${qs({ itemId: item })}`);
  if (!mine.ok) return { result: mine.status === 403 ? refused(`"${item}" is requested in its own workspace, not from here.`) : readFailure('your access requests', mine.status) };
  const open = (mine.body.items ?? []).find((r) => r.status === 'pending' || r.status === 'in_review' || r.status === 'submitted');
  if (open) return { result: refused(`You already asked for it: request ${open.id} is ${open.status}. I will say when it is decided.`, { existing: `request:${open.id}` }) };
  const body = { itemId: item, justification: voiceJustification(ctx.tenant, said), duration };
  return card(`Request ${item} for ${duration === '7d' ? 'a week' : duration}`, [said, 'Your manager and the item\'s steward approve it in Access; the access arrives on this session once approved.'],
    { key: `POST /api/access-requests/quick ${item} ${duration}`, send: { method: 'POST', url: '/api/access-requests/quick', body }, done: `Requested ${item}`, result: { kind: 'access-request', item }, idAt: 'id' });
}

/** G25: the meeting's reply in its thread (the time and the room), or nothing to send; the result says no calendar exists. */
async function runMeeting(ctx: ToolContext, plan: ActPlan, m: MeetingPlan): Promise<ToolResult> {
  return once(ctx, plan.key, async () => {
    if (m.reply) {
      const social = ctx.social;
      if (!social) return socialGrantRefusal(ctx, 'The reply goes through Social, which this session cannot reach.');
      const text = `Let's meet at ${m.time} in the ${m.initiative} huddle: ${m.href} (no calendar invite; start or join the huddle from that page).`;
      try {
        await social.send({ channel: m.reply.channel, text, deliveryId: deliveryIdFor(ctx, plan.key), ...(m.reply.replyTo ? { replyTo: m.reply.replyTo } : {}) });
      } catch (err) {
        return failed(`The meeting note to ${m.reply.to} was not confirmed: ${(err as Error)?.message ?? 'no receipt'}.`);
      }
    }
    return done('meeting', {
      ...plan.result, href: m.href, ...(m.reply ? { told: m.reply.to } : {}),
      say: `${m.reply ? `I told ${m.reply.to}: ${m.time} in the ${m.initiative} huddle. ` : ''}${NO_CALENDAR}`,
    }, plan.done);
  }, () => done('meeting', { ...plan.result, already: true }, `${plan.done} already; nothing was sent again`));
}

// ── update ──

/** A work item's status moves the server allows (providers/work-items.ts), so the card never offers one it refuses. */
const WORK_MOVES: Readonly<Record<string, readonly string[]>> = {
  open: ['in_progress', 'cancelled'], in_progress: ['in_review', 'done', 'open', 'cancelled'], in_review: ['in_progress', 'done', 'cancelled'],
  done: ['in_progress'], cancelled: ['open'],
};
const words = (s: string) => s.replace(/_/g, ' ');

async function planUpdateKind(kind: string, field: string, value: unknown, fields: Rec, ref: string, ctx: ToolContext): Promise<{ plan: ConfirmPlan } | { result: ToolResult }> {
  const card = (title: string, detail: string[], a: ActPlan) => ({ plan: { title, detail, data: a } satisfies ConfirmPlan });
  if (kind === 'report') {
    if (ref !== 'report:program' || value !== true) return { result: refused('Publish the program report with ref "report:program" and publish true.') };
    return card('Publish the program report', ['Readers of the assessment see the scores as they stand now.'],
      { key: 'POST /api/assessment/reports/publish', send: { method: 'POST', url: '/api/assessment/reports/publish', body: {} }, done: 'Published the program report', result: { ref }, href: '/assessment/reports' });
  }
  if (kind === 'work-item') return planWorkItemUpdate(field, value, ref, ctx);
  const found = await findByName(ctx, kind, ref);
  if ('result' in found) return found;
  const row = found.row;
  const id = enc(row.id);
  const named = `"${row.title}"`;
  const mk = (title: string, detail: string[], method: Send['method'], url: string, body: Record<string, unknown>, doneLine: string): { plan: ConfirmPlan } =>
    card(title, detail, { key: `${method} ${url} ${JSON.stringify(body)}`, send: { method, url, body }, done: doneLine, result: { ref: `${kind}:${row.id}`, [field]: value }, ...(row.href ? { href: row.href } : {}) });
  const statusNow = String(row.status ?? '');
  switch (`${kind}.${field}`) {
    case 'bot.paused':
      return value === true
        ? mk(`Pause the ${row.title} bot`, ['Its schedule stops until it is resumed.'], 'POST', `/api/bots/${id}/pause`, {}, `Paused ${row.title}`)
        : mk(`Resume the ${row.title} bot`, ['Its schedule runs again and spends against its budget.'], 'POST', `/api/bots/${id}/resume`, {}, `Resumed ${row.title}`);
    case 'finding.status':
      if (value !== 'dismissed') return { result: refused('A finding is only dismissed by voice.') };
      return mk(`Dismiss the finding ${named}`, ['It leaves the findings board.'], 'POST', `/api/work/findings/${id}/dismiss`, {}, `Dismissed ${row.title}`);
    case 'job.reviewed':
      if (statusNow !== 'awaiting_review') return { result: refused(`${named} is ${words(statusNow) || 'not'} waiting for review.`) };
      return mk(`${value === 'accept' ? 'Accept' : 'Reject'} the result of ${named}`, [value === 'accept' ? 'The job is done.' : 'The job is rejected and its finding reopens.'], 'POST', `/api/work/jobs/${id}/review`, { decision: value }, `${value === 'accept' ? 'Accepted' : 'Rejected'} ${row.title}`);
    case 'job.requeued':
      if (!['failed', 'cancelled'].includes(statusNow)) return { result: refused(`${named} is ${words(statusNow)}; only a failed or cancelled job runs again.`) };
      return mk(`Run ${named} again`, ['A new job is queued for the fleet and spends against its initiative.'], 'POST', `/api/work/jobs/${id}/requeue`, {}, `Queued ${row.title} again`);
    case 'channel.member': {
      const base = ctx.tenant === 'social' ? '/api/social' : '/api/social/plane';
      if (value === true) {
        // Joining posts membership the channel's people see: the route asks PostMessage (the plane's grant outside Social).
        if (!ctx.can('PostMessage')) return { result: refused("I can't join channels with your role.") };
        return mk(`Join ${channelTag(row.id)}`, ['Its people see you join; you can post there.'], 'POST', `${base}/channels/${id}/join`, {}, `Joined ${channelTag(row.id)}`);
      }
      return mk(`Leave ${channelTag(row.id)}`, ['You stop seeing its messages.'], 'POST', `${base}/channels/${id}/leave`, {}, `Left ${channelTag(row.id)}`);
    }
    case 'dm.read':
      if (value !== true) return { result: refused('A conversation is marked read, never unread, by voice.') };
      return mk(`Mark your conversation with ${row.title} read`, [], 'POST', '/api/social/dms/read', { channel: row.id }, `Marked ${row.title} read`);
    case 'run.status':
      if (ctx.tenant === 'assessment') {
        if (value !== 'stopped') return { result: refused('An assessment run is only stopped by voice.') };
        if (statusNow && statusNow !== 'running') return { result: refused(`That run is already ${words(statusNow)}.`) };
        return mk(`Stop the ${row.title} run`, ['It ends as stopped; what it drafted stays for review.'], 'POST', `/api/assessment/runs/${id}/stop`, {}, `Stopped ${row.title}`);
      }
      if (value !== 'cancelled') return { result: refused('A pipeline run is only cancelled by voice.') };
      if (statusNow && !['queued', 'claimed', 'pending'].includes(statusNow)) return { result: refused(`That run is ${words(statusNow)}; only a queued run is cancelled.`) };
      return mk(`Cancel the run ${named}`, ['It leaves the queue before it starts.'], 'POST', `/api/pipelines/runs/${id}/cancel`, {}, `Cancelled ${row.title}`);
    case 'feedback.status': {
      if (value === 'dismissed') return mk(`Dismiss the follow-up ${named}`, [], 'POST', `/api/assessment/feedback/${id}/dismiss`, {}, `Dismissed ${row.title}`);
      if (value !== 'resolved') return { result: refused('A follow-up is resolved or dismissed.') };
      const response = str(fields['response']);
      if (!response) return { result: refused('Resolving a follow-up needs the response; say it.') };
      return mk(`Resolve the follow-up ${named}`, [response], 'POST', `/api/assessment/feedback/${id}/resolve`, { response }, `Resolved ${row.title}`);
    }
    case 'request.status':
      if (value !== 'withdrawn') return { result: refused('An access request is only withdrawn by voice.') };
      if (dig(row.raw, 'can.withdraw') !== true) return { result: refused(`${named} cannot be withdrawn now.`) };
      return mk(`Withdraw your request for ${row.title}`, ['Its approvers stop seeing it.'], 'POST', `/api/access/requests/${id}/withdraw`, {}, `Withdrew ${row.title}`);
    case 'delegation.status':
      if (value !== 'ended') return { result: refused('A delegation is only ended by voice.') };
      if (dig(row.raw, 'can.end') !== true) return { result: refused(`${row.title} cannot be ended by you now.`) };
      return mk(`End the delegation ${row.title}`, ['The requests waiting on you come back to you.'], 'POST', `/api/access/delegations/${id}/end`, { reason: 'Ended early by voice' }, `Ended ${row.title}`);
    default:
      return { result: refused(`A ${kind.replace(/-/g, ' ')} does not take ${field} here.`) };
  }
}

/**
 * Coverage (10 November): a work item's status, owner or sprint, through the button its drawer and the sprint board
 * use. The row is read again through the board read its page makes (tools.ts workItemRow), never the model's words.
 */
async function planWorkItemUpdate(field: string, value: unknown, ref: string, ctx: ToolContext): Promise<{ plan: ConfirmPlan } | { result: ToolResult }> {
  const id = parseRef(ref)!.id;
  const found = await workItemRow(ctx, id);
  if ('result' in found) return found;
  const w = found.row;
  const named = `"${w.title}"`;
  const key = (method: string, url: string, body: unknown) => `${method} ${url} ${JSON.stringify(body)}`;
  const href = w.projectId ? `/iq/projects/${enc(w.projectId)}?item=${enc(w.id)}` : undefined;
  const plan = (title: string, detail: string[], send: Send, doneLine: string, result: Record<string, unknown>) =>
    ({ plan: { title, detail, data: { key: key(send.method, send.url, send.body), send, done: doneLine, result: { ref: `work-item:${w.id}`, ...result }, ...(href ? { href } : {}) } satisfies ActPlan } satisfies ConfirmPlan });
  const statusNow = String(w.status ?? '');
  if (w.projectId) {
    const off = await offInitiative(ctx, w.projectId);
    if (off) return off;
  }
  if (field === 'status') {
    const to = String(value);
    if (statusNow === to) return { result: refused(`${named} is already ${words(to)}.`) };
    if (statusNow && !(WORK_MOVES[statusNow] ?? []).includes(to)) return { result: refused(`${named} is ${words(statusNow)}; from there it moves to ${(WORK_MOVES[statusNow] ?? []).map(words).join(' or ') || 'nothing'}.`) };
    const url = `/api/graph/work-items/${enc(w.id)}`;
    return plan(`Move ${named} to ${words(to)}`, [`It is ${words(statusNow) || 'unknown'} now.`], { method: 'PATCH', url, body: { status: to } }, `${w.title}: ${words(to)}`, { status: to });
  }
  if (!w.projectId) return { result: refused(`${named} belongs to no initiative I can read.`, { code: 'not-on-initiative' }) };
  if (field === 'assignee') {
    // The drawer's owner picker offers the initiative's contributors (GET /api/graph/projects/:id), and so does this.
    const read = await readJson<{ contributors?: Array<{ personId?: string; name?: string }> }>(ctx, `/api/graph/projects/${enc(w.projectId)}`);
    if (!read.ok) return { result: readFailure('the initiative\'s people', read.status) };
    const people = (read.body.contributors ?? []).filter((p): p is { personId: string; name: string } => typeof p.personId === 'string' && typeof p.name === 'string');
    const said = String(value).trim();
    const hits = people.filter((p) => samePerson(p.name, said, ctx));
    if (!hits.length) return { result: refused(/^(me|myself|i)$/i.test(said) ? `You are not on this initiative's people, so ${named} cannot be yours.` : `No one called "${said}" works on this initiative; its people own its work.`, { code: 'not-found' }) };
    if (hits.length > 1) return { result: ambiguous(`Several people on this initiative match "${said}". Ask which.`, hits.map((p) => ({ name: p.name }))) };
    const who = hits[0]!;
    if (w.assigneeName === who.name) return { result: refused(`${named} is already ${who.name}'s.`) };
    const url = `/api/graph/work-items/${enc(w.id)}`;
    return plan(`Give ${named} to ${who.name}`, [`It is ${w.assigneeName ? `${w.assigneeName}'s` : 'unassigned'} now; ${who.name} is told.`], { method: 'PATCH', url, body: { assigneeId: who.personId } },
      `${w.title}: assigned to ${who.name}`, { assignee: who.name });
  }
  // sprint: the sprint board's own move in (PATCH) or out (DELETE), on the item's own initiative.
  const said = String(value).trim();
  if (/^(none|no sprint|backlog|out|remove)$/i.test(said)) {
    if (!w.sprintId) return { result: refused(`${named} is in no sprint.`) };
    const url = `/api/sprints/${enc(w.sprintId)}/items/${enc(w.id)}`;
    return plan(`Take ${named} out of its sprint`, ['It goes back to the backlog.'], { method: 'DELETE', url, body: {} }, `${w.title}: out of the sprint`, { sprint: null });
  }
  const sprint = await resolveSprint(ctx, w.projectId, said);
  if ('result' in sprint) return sprint;
  if (w.sprintId === sprint.sprint.id) return { result: refused(`${named} is already in ${sprint.sprint.name}.`) };
  const url = `/api/sprints/${enc(sprint.sprint.id)}/items`;
  return plan(`Put ${named} in ${sprint.sprint.name}`, [`${sprint.sprint.status === 'active' ? 'The active sprint' : `A ${sprint.sprint.status} sprint`}; its envelope covers dispatches of it.`], { method: 'PATCH', url, body: { workItemId: w.id } },
    `${w.title}: in ${sprint.sprint.name}`, { sprint: sprint.sprint.name });
}

const planUpdate: VoiceToolPlanner = async (args, ctx) => {
  let ref = String(args['ref']).trim();
  if (/^\d{1,2}$/.test(ref)) {
    const strict = positionRefusal(ctx, ref);
    if (strict) return { result: strict };
    const kept = ctx.results?.find(ref);
    if (!kept) return { result: refused(`There is no row ${ref} in the last result. List them first.`) };
    ref = kept.ref;
  } else if (!parseRef(ref) && ctx.page?.()?.rows.length) {
    // Coverage (10 November): "move the logout bug to in review" names a row the page in view shows.
    const hit = pageRowNamed(ctx, ref);
    if ('result' in hit) return hit;
    ref = hit.row.ref;
  }
  const parsed = parseRef(ref);
  if (!parsed) return { result: refused('Name the row by the ref a result gave, such as "work-item:<id>", or its position.') };
  const kinds = UPDATE_ACTIONS[ctx.tenant] ?? {};
  const allowed = kinds[parsed.kind];
  if (!allowed) return { result: refused(`A ${parsed.kind.replace(/-/g, ' ')} is not changed by voice in this workspace.`) };
  const fields = (args['fields'] as Rec | undefined) ?? {};
  const given = Object.keys(fields).filter((k) => k !== 'response');
  const field = given[0];
  if (given.length !== 1 || !field || !(field in allowed) || (fields['response'] !== undefined && parsed.kind !== 'feedback')) {
    return { result: refused(`A ${parsed.kind.replace(/-/g, ' ')} takes one change here: ${Object.keys(allowed).join(' or ')}.`) };
  }
  const action = allowed[field];
  // Leaving a channel needs only the Social grant (ViewSocial), joining the route's PostMessage (checked in the planner).
  const leaving = parsed.kind === 'channel' && fields['member'] === false;
  if (action && !leaving && action !== 'PostMessage' && !ctx.can(action)) return { result: refused(`I can't change that with your role.`) };
  if ((parsed.kind === 'channel' || parsed.kind === 'dm') && ctx.tenant !== 'social' && !ctx.social) {
    return { result: socialGrantRefusal(ctx, 'Channels and conversations are in Social, which this session cannot reach.') };
  }
  return planUpdateKind(parsed.kind, field, fields[field], fields, ref, ctx);
};

const runUpdate: VoiceToolRunner = async (_args, ctx, planned) => {
  const plan = planned as ActPlan | undefined;
  if (!plan?.send) return refused('Nothing changes until the user confirms its card.');
  return act(ctx, plan, 'changed');
};

export const RECORD_PLANNERS: Readonly<Record<string, VoiceToolPlanner>> = { decide: planDecide, create: planCreate, update: planUpdate };
export const RECORD_RUNNERS: Readonly<Record<string, VoiceToolRunner>> = { decide: runDecide, create: runCreate, update: runUpdate };

export type { VoiceToolArgs };
