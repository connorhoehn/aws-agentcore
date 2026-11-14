// The call assistant's turns in the asker's own browser (docs/meeting-assistant-design.md, decision 5).
// The server never runs a tool. It lists the turns made for this person (`GET …/assistant/turns?mine=1`); this module
// runs each one exactly once through the voice navigator's executor (voice/runCore.ts) and posts the result back.
// A turn is claimed on the server first (`POST …/turns/:id/claim`); only a 200 runs it, with the tool and kind the claim
// answered, so two tabs of one person make one run. A read runs when it is pending. A write runs only when the server
// says it is `running`, which it becomes only after the asker confirmed its card; a pending write is never run.
// A result that fails to post is kept (memory and sessionStorage) and retried until the turn's expiry by the server's
// clock. Pure of React, so node:test covers it.

import type { CallToolOutcome } from './voice/runCore.ts';

export const SAY_MAX_CHARS = 600;

export type TurnKind = 'read' | 'write' | 'private-read';

export interface AssistantTurn {
  turnId: string;
  kind: TurnKind;
  status: string;
  tool: { name: string; args: unknown };
  expiresAt: number;
}

/** The turns the server listed; a row that is not shaped like a turn is dropped. */
export function parseTurns(body: unknown): AssistantTurn[] {
  const list = body && typeof body === 'object' ? (body as Record<string, unknown>)['turns'] : null;
  if (!Array.isArray(list)) return [];
  const out: AssistantTurn[] = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const tool = r['tool'] && typeof r['tool'] === 'object' ? r['tool'] as Record<string, unknown> : null;
    if (typeof r['turnId'] !== 'string' || !tool || typeof tool['name'] !== 'string' || typeof r['expiresAt'] !== 'number') continue;
    if (r['kind'] !== 'read' && r['kind'] !== 'write' && r['kind'] !== 'private-read') continue;
    out.push({ turnId: r['turnId'], kind: r['kind'], status: String(r['status'] ?? ''), tool: { name: tool['name'], args: tool['args'] }, expiresAt: r['expiresAt'] });
  }
  return out;
}

/** Turn ids this browser has taken. In memory, and in sessionStorage so a reload does not run one twice. */
export class SeenTurns {
  private readonly ids = new Set<string>();
  private readonly key: string;
  private readonly storage: () => Storage | null;
  constructor(key: string, storage: () => Storage | null = defaultStorage) {
    this.key = key; this.storage = storage;
    try {
      const raw = this.storage()?.getItem(this.key);
      const list: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') this.ids.add(id);
    } catch { /* storage may be blocked: memory alone then */ }
  }
  has(id: string): boolean { return this.ids.has(id); }
  /** Marks a turn taken, before it runs. */
  add(id: string): void {
    this.ids.add(id);
    while (this.ids.size > 200) this.ids.delete(this.ids.values().next().value as string);
    try { this.storage()?.setItem(this.key, JSON.stringify([...this.ids])); } catch { /* memory alone */ }
  }
}

function defaultStorage(): Storage | null {
  try { return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null; } catch { return null; }
}

/** What the server answered a claim with. Only `claimed` runs; `refused` (404 or 409) is skipped silently; `error` (offline, 5xx) asks again later. */
export type ClaimResult =
  | { status: 'claimed'; claimId: string; kind: TurnKind; tool: { name: string; args: unknown }; /** The turn's expiry after the claim (server clock), when the server said. */ expiresAt?: number }
  | { status: 'refused' }
  | { status: 'error' };

/** Reads a claim's 200 body; anything unlike a claim is `error`, never a run. */
export function parseClaim(body: unknown): ClaimResult {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  const tool = b && b['tool'] && typeof b['tool'] === 'object' ? b['tool'] as Record<string, unknown> : null;
  if (!b || typeof b['claimId'] !== 'string' || !b['claimId'] || !tool || typeof tool['name'] !== 'string') return { status: 'error' };
  if (b['kind'] !== 'read' && b['kind'] !== 'write' && b['kind'] !== 'private-read') return { status: 'error' };
  return { status: 'claimed', claimId: b['claimId'], kind: b['kind'], tool: { name: tool['name'], args: tool['args'] }, ...(typeof b['expiresAt'] === 'number' && Number.isFinite(b['expiresAt']) ? { expiresAt: b['expiresAt'] } : {}) };
}

export interface ResultBody { ok: boolean; output?: unknown; error?: string }

/** A result run and not yet accepted by the server. */
export interface PendingResult { turnId: string; claimId: string; expiresAt: number; body: ResultBody }

/** Results waiting to be accepted: in memory and sessionStorage, so a reload re-posts instead of re-running. */
export class PendingResults {
  private readonly map = new Map<string, PendingResult>();
  private readonly retry = new Map<string, { tries: number; nextAt: number }>();
  private readonly key: string;
  private readonly storage: () => Storage | null;
  constructor(key: string, storage: () => Storage | null = defaultStorage) {
    this.key = key; this.storage = storage;
    try {
      const raw = this.storage()?.getItem(this.key);
      const list: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) for (const r of list) {
        if (r && typeof r === 'object' && typeof r.turnId === 'string' && typeof r.claimId === 'string' && typeof r.expiresAt === 'number' && r.body && typeof r.body === 'object') this.map.set(r.turnId, r as PendingResult);
      }
    } catch { /* memory alone */ }
  }
  list(): PendingResult[] { return [...this.map.values()]; }
  get size(): number { return this.map.size; }
  add(r: PendingResult): void { this.map.set(r.turnId, r); this.save(); }
  remove(turnId: string): void { this.map.delete(turnId); this.retry.delete(turnId); this.save(); }
  /** After a failed post: when to try again (1 s, 2 s, 4 s, … capped at 15 s). */
  failed(turnId: string, wall: number): number {
    const tries = (this.retry.get(turnId)?.tries ?? 0) + 1;
    const nextAt = wall + Math.min(1000 * 2 ** (tries - 1), 15_000);
    this.retry.set(turnId, { tries, nextAt });
    return nextAt;
  }
  dueAt(turnId: string): number { return this.retry.get(turnId)?.nextAt ?? 0; }
  private save(): void {
    try { this.storage()?.setItem(this.key, JSON.stringify([...this.map.values()])); } catch { /* memory alone */ }
  }
}

export interface TurnDeps {
  seen: SeenTurns;
  pending: PendingResults;
  /** The server's clock: the browser's offset from the server's `Date` header applied. Turn expiry is read against this. */
  now(): number;
  /** The browser's own clock, only for spacing retries. Defaults to Date.now. */
  wall?(): number;
  /** Claims a turn on the server. */
  claim(turnId: string): Promise<ClaimResult>;
  /** Runs a tool with this person's own context (voice/runCore.ts runCallTool). */
  run(name: string, args: unknown, write: boolean): Promise<CallToolOutcome>;
  /** Posts the result; resolves with the HTTP status (0 when the request never got an answer). */
  post(turnId: string, body: ResultBody & { claimId: string }): Promise<number>;
}

/** Whether a listed turn may be claimed now: a read is pending, a write is running (its card was confirmed), neither expired. */
export function runnable(turn: AssistantTurn, now: number): boolean {
  if (turn.expiresAt <= now) return false;
  return turn.kind === 'write' ? turn.status === 'running' : turn.status === 'pending';
}

/** The plain sentence a private read sends the server: built the way the voice navigator speaks the same result (`say`, from wireOutput), at most 600 characters. */
export function privateSay(output: Record<string, unknown> | undefined): string {
  const say = typeof output?.['say'] === 'string' ? output['say'].replace(/\s+/g, ' ').trim() : '';
  const line = say || 'Nova looked it up, but there was nothing to say.';
  return line.length > SAY_MAX_CHARS ? `${line.slice(0, SAY_MAX_CHARS - 1).trimEnd()}…` : line;
}

/** The body a finished run posts. A private read sends only `{ say }`, so nothing else of the person's data leaves the browser. */
export function resultBody(kind: TurnKind, out: CallToolOutcome): ResultBody {
  if (!out.ok) return { ok: false, error: out.error ?? 'It did not work.' };
  if (kind === 'private-read') return { ok: true, output: { say: privateSay(out.output) } };
  return { ok: true, output: out.output ?? {} };
}

/** Final answers: the server took it (200) or will never take it (409, 404, 413, 400). Anything else is tried again. */
const isFinal = (status: number): boolean => status === 200 || status === 409 || status === 404 || status === 413 || status === 400;

/**
 * Posts every kept result that is due. A result whose turn has expired by the server's clock is dropped (the server
 * says so in the chat). Returns the earliest wall-clock time a failed one should be tried again, or null.
 */
export async function flushResults(deps: Pick<TurnDeps, 'pending' | 'now' | 'wall' | 'post'>): Promise<number | null> {
  const wall = deps.wall ?? Date.now;
  let next: number | null = null;
  for (const item of deps.pending.list()) {
    if (item.expiresAt <= deps.now()) { deps.pending.remove(item.turnId); continue; }
    if (deps.pending.dueAt(item.turnId) > wall()) { next = Math.min(next ?? Infinity, deps.pending.dueAt(item.turnId)); continue; }
    let status = 0;
    try { status = await deps.post(item.turnId, { claimId: item.claimId, ...item.body }); } catch { status = 0; }
    if (isFinal(status)) deps.pending.remove(item.turnId);
    else next = Math.min(next ?? Infinity, deps.pending.failed(item.turnId, wall()));
  }
  return next;
}

/** Claims and runs every listed turn that may run and has not been taken. Serial, so two never overlap. Returns how many ran. */
export async function processTurns(turns: readonly AssistantTurn[], deps: TurnDeps): Promise<number> {
  let ran = 0;
  for (const turn of turns) {
    if (deps.seen.has(turn.turnId) || deps.pending.list().some((p) => p.turnId === turn.turnId) || !runnable(turn, deps.now())) continue;
    const claim = await deps.claim(turn.turnId);
    if (claim.status === 'error') continue;
    deps.seen.add(turn.turnId);
    if (claim.status !== 'claimed') continue;
    let out: CallToolOutcome;
    try {
      out = await deps.run(claim.tool.name, claim.tool.args, claim.kind === 'write');
    } catch (error) {
      out = { ok: false, error: `That did not run: ${(error as Error).message}`.slice(0, 280) };
    }
    deps.pending.add({ turnId: turn.turnId, claimId: claim.claimId, expiresAt: Math.max(turn.expiresAt, claim.expiresAt ?? 0), body: resultBody(claim.kind, out) });
    ran += 1;
    await flushResults(deps);
  }
  return ran;
}

/** How often the browser asks for its turns while the person is seated in a live call and the page is in front. */
export const TURN_POLL_MS = 2000;
/** The same while another window is in front: slower, but never off (a read expires after 90 s, a confirmed write must run). */
export const TURN_POLL_HIDDEN_MS = 5000;
/** What the runner is doing: `active` polls on a timer (seated in a live call), `poke` polls only after a confirmed card, `off` does nothing. */
export type TurnRunnerMode = 'active' | 'poke' | 'off';
/** The wait before the next scheduled poll, or null when this mode does not poll on a timer. A hidden tab polls slower, it does not stop. */
export function turnPollBaseMs(mode: TurnRunnerMode, hidden: boolean): number | null {
  return mode === 'active' ? (hidden ? TURN_POLL_HIDDEN_MS : TURN_POLL_MS) : null;
}

/** Every request the turn runner makes ends within this long, so one hung request cannot hold the runner. */
export const EXECUTOR_REQUEST_MS = 30_000;

export interface PollChainDeps<H> {
  /** One poll; true when the server answered. */
  poll(): Promise<boolean>;
  /** The wait before the next poll after `failures` failures in a row, or null for no timer (the mode polls only when poked). */
  nextMs(failures: number): number | null;
  schedule(fn: () => void, ms: number): H;
  cancel(handle: H): void;
}

/**
 * One timer chain per runner. A tick that is running owns the next timer, so a nudge (a visibility change) that arrives
 * during a poll starts nothing; a nudge between polls replaces the waiting timer with an immediate poll.
 */
export function pollChain<H>(deps: PollChainDeps<H>): { start(): void; nudge(): void; stop(): void } {
  let stopped = false;
  let ticking = false;
  let failures = 0;
  let timer: H | null = null;
  const tick = async (): Promise<void> => {
    timer = null;
    if (stopped || ticking) return;
    ticking = true;
    try { failures = (await deps.poll()) ? 0 : failures + 1; } finally { ticking = false; }
    const wait = deps.nextMs(failures);
    if (!stopped && wait !== null) timer = deps.schedule(() => void tick(), wait);
  };
  return {
    start: () => { void tick(); },
    nudge: () => { if (stopped || ticking) return; if (timer !== null) deps.cancel(timer); void tick(); },
    stop: () => { stopped = true; if (timer !== null) deps.cancel(timer); },
  };
}
