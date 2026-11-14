// The part of a voice tool call that does not belong to a voice session: validate, gate, plan, run, and shape what the
// model is sent. The voice controller shapes its tool output with `wireOutput`; the call assistant's browser turns
// (lib/meetingTurns.ts) run through `runCallTool`. Both go through the same executor functions (tools.ts, actions.ts),
// so the gates are the same: the catalogue's schema, the tool's can() action, and the runner's own route checks.

import { VOICE_PLANNERS, VOICE_RUNNERS } from './actions.ts';
import { briefOutput, modelOutput, withSay } from './contextWindow.ts';
import { withFailure } from './refusals.ts';
import { needsConfirm, planPreparedCall, prepareToolCall, runPreparedCall, toolAvailable, type ToolContext, type ToolResult } from './tools.ts';

/** What the model is sent of a result: the ready line added, long lists briefed, links stripped, size capped. */
export function wireOutput(name: string, args: unknown, res: Pick<ToolResult, 'outcome' | 'output' | 'summary'>): Record<string, unknown> {
  return modelOutput(briefOutput(name, args, withSay(name, res.outcome, res.output, res.summary)));
}

/** Tools a call never runs in a browser: they move the page, run a machine or start a call (the server leaves them out too). */
export const CALL_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['open', 'computer', 'call']);

/** The route's own limit on a result body is 16 KB; stay under it with room for the envelope. */
export const MAX_RESULT_CHARS = 14_000;

export interface CallToolOutcome {
  ok: boolean;
  /** On success, what the model is sent (done) and, for a write, the `say` line the card shows. */
  output?: Record<string, unknown>;
  /** On failure, one plain sentence. */
  error?: string;
}

const sentence = (s: unknown, fallback: string): string => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return (t || fallback).slice(0, 280);
};

/**
 * Runs one tool for a person in a call, with that person's own context. `write` says the server made this turn for a
 * confirmed card; a turn for a read never runs a tool that needs a confirm card.
 */
export async function runCallTool(name: string, rawArgs: unknown, given: ToolContext, opts: { write: boolean }): Promise<CallToolOutcome> {
  // A write names its record exactly (tools.ts strictTargets); the resolvers report what they settled on.
  const resolved: Array<{ ref: string; title: string }> = [];
  const ctx: ToolContext = opts.write ? { ...given, strictTargets: true, resolvedTargets: resolved } : given;
  if (CALL_EXCLUDED_TOOLS.has(name)) return { ok: false, error: 'That cannot be done from a call.' };
  const prepared = prepareToolCall(name, rawArgs, ctx);
  if (!prepared.ok) return { ok: false, error: sentence(prepared.result.output['say'] ?? prepared.result.summary, 'You cannot do that here.') };
  const call = prepared.call;
  if (!toolAvailable(name, VOICE_RUNNERS)) return { ok: false, error: 'That tool cannot be run from a call.' };
  if (!opts.write && needsConfirm(call)) return { ok: false, error: 'That needs a confirmation card, so it was not run.' };
  let plan: unknown;
  if (opts.write && VOICE_PLANNERS[name]) {
    const planned = await planPreparedCall(call, ctx, VOICE_PLANNERS);
    if (planned && 'result' in planned) return outcomeOf(name, call.args, planned.result, true, resolved);
    plan = planned?.plan.data;
  }
  return outcomeOf(name, call.args, await runPreparedCall(call, ctx, VOICE_RUNNERS, plan), opts.write, resolved);
}

function outcomeOf(name: string, args: unknown, given: ToolResult, write: boolean, resolved: ReadonlyArray<{ title: string }> = []): CallToolOutcome {
  const res = withFailure(given, name);
  if (res.outcome !== 'done') return { ok: false, error: sentence(res.output['say'] ?? res.output['reason'] ?? res.summary, 'It did not work.') };
  let output = wireOutput(name, args, res);
  if (write && typeof output['say'] !== 'string') output = { ...output, say: 'Done.' };
  // The card ends with what was changed: the resolved record's own title.
  const title = resolved[0]?.title.trim();
  const say = output['say'];
  if (write && title && typeof say === 'string' && !say.toLowerCase().includes(title.toLowerCase())) {
    output = { ...output, say: `${say.replace(/[.\s]+$/, '')}: ${title}.` };
  }
  if (JSON.stringify(output).length > MAX_RESULT_CHARS) output = { say: sentence(output['say'], 'Done.'), truncated: true };
  return { ok: true, output };
}
