// Portal-specific command catalog for the shared CommandPalette. Translates
// the OrgIQ tenant/role/path conventions into the generic Command[] surface
// exposed by @connorhoehn/ui-components/shared.
//
// Three contributions:
//   1. usePortalCommands() — static page jumps + recent harness runs, gated
//      by tenant/role. Grouped by tenant for the SubNav-style heading.
//   2. usePortalDynamicCommands() — query-derived commands: a UUID-paste
//      shortcut that jumps to the invocation detail view.
//
// Note: the legacy '>' cross-tenant escape prefix is not carried over to the
// new lib (cmdk's filter doesn't have a clean opt-out per-item). If the
// affordance is missed in practice, revisit by setting forceMount on the
// synthetic commands.

import { meetingsAdvertised } from '../../lib/meetingAssistantModel';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Command } from '@connorhoehn/ui-components/shared';
import { useSession } from '../../lib/auth';
import { openShell, useComputeOptional } from '@connorhoehn/ui-components/compute';
import { commandKeywords } from './commandKeywords';
import { features } from '../../lib/features';
import { offerPage } from '../../lib/pageAccess';

export type PageTenant = 'orgiq' | 'assessment' | 'social' | 'pipelines' | 'access' | 'admin' | 'universal';

export interface PageEntry {
  label: string;
  hint: string;
  path: string;
  tenant: PageTenant;
  /** Palette group — mirrors the rail's Build/Org/Operate/System grouping. */
  group: string;
  /** Extra search terms — the words a person would actually type, not just
      the label. cmdk only matches `${id} ${label} ${keywords.join(' ')}`, so
      the `hint` prose (the only place a lot of these words lived) was
      invisible to search: "repo" found nothing for Codebases, "machine"
      nothing for Local compute, "sprint" nothing for Initiatives, "review"/
      "PR" nothing for Changes. Domain-language aliases from the synonym
      audit: initiative/project/program; codebase/repository/repo;
      bot/cron/mission/agent; job/run/invocation/dispatch; machine/node/
      laptop/local; devbox/computer/box/lab; finding/sweep/signal;
      artifact/asset/library item; certification/maturity/level. */
  keywords?: string[];
  /** Roles that may open it; omitted = any role in the right tenant. The
      cross-tenant 'admin' role bypasses this, same as the nav and routes. */
  roles?: string[];
  /** The id the voice navigator's `navigate` tool names this page by
      (middleware/src/lib/voice/catalogue.ts NAVIGATE_PAGES); omitted = not offered to voice. */
  pageId?: string;
  /** A page whose route exists only behind a feature (`features` in lib/features.ts): the palette hides it while that is off. */
  feature?: 'voiceLog' | 'meetingAssistant';
}

interface RecentRun {
  runId: string;
  label?: string;
  startedAt?: string;
  passRate?: number | null;
  status?: string;
}

// The full navigable surface, grouped the way the rail groups it. Every page
// with a rail or sub-rail entry is here; gates mirror the routes' RequireRole
// so the palette never offers a jump that bounces.
// Each list mirrors the Cedar grant behind the route (middleware/seeds/roles/orgiq/*.cedar)
// and the matching RequireRole in App.tsx — the palette never offers a jump that bounces.
const PLATFORM = ['org-leader', 'hr-admin'];
const BUILD = ['hr-admin'];
const BUDGETS = ['program-owner', 'org-leader', 'hr-admin'];   // ManageBudgets
const BOTS = ['sme', 'program-owner', 'org-leader', 'hr-admin']; // ManageBots
const CHANGES = ['program-owner', 'hr-admin'];

// Rail group order per tenant (top → bottom): the org tenant reads along its
// SDLC arc; the assessment tenant top-down through its own programme. The
// rail and the palette share this so ⌘K lists pages in the order the rail
// shows them — a group a tenant doesn't list sorts last, never vanishes.
export const GROUP_ORDER_BY_TENANT: Record<string, string[]> = {
  orgiq: ['Plan', 'Design', 'Build', 'Release', 'Operate', 'Engage', 'System'],
  assessment: ['Assess', 'Analyze', 'Informatics', 'System'],
  // docs/social-tenant-design.md §4.1 — talk, meet, the people you do it
  // with, what was recorded, then the tenant's own configuration.
  social: ['Talk', 'Meet', 'People', 'Library', 'System'],
  // docs/social-tenant-design.md §5.3 — what can run, what ran, who produced
  // it, then configuration.
  pipelines: ['Catalog', 'Runs', 'Sources', 'System'],
  // docs/access-tenant-design.md §6 — ask for access, decide what waits on
  // you, govern what was granted, then configuration.
  access: ['Request', 'Approve', 'Govern', 'System'],
};
export function groupRank(tenant: string, group?: string): number {
  const order = GROUP_ORDER_BY_TENANT[tenant] ?? GROUP_ORDER_BY_TENANT['orgiq']!;
  const n = order.indexOf(group ?? 'System');
  return n < 0 ? order.length : n;
}

// Every assessment role may READ /assessment/configuration — `GET
// /configuration` is gated `ViewAssessment`, which all three roles hold, and
// the page itself disables every input and hides Save behind `canManage`
// (program-lead only). The palette used to hide the entry from everyone but
// program-lead, which was the palette disagreeing with both the server and
// the route (App.tsx carries no RequireRole here on purpose). The route and
// the server are right; only this gate needed widening.
const ASSESSMENT_ROLES = ['assessor', 'lead-assessor', 'program-lead'];

// Exported for the voice navigator (lib/voice/tools.ts): `navigate` opens only
// what this table offers, gated by the same isPageVisible.
export const PAGES: readonly PageEntry[] = [
  // ── Plan → Build — the SDLC loop (Plan rows lead the rail; the palette groups by `group`) ──
  { label: 'Automate',           hint: 'The agent loop — queue, bots, review', path: '/iq/work',                                    tenant: 'orgiq',  group: 'Build', pageId: 'automate',
    keywords: ['work', 'queue', 'bots', 'review', 'automate', 'dispatch', 'agent loop'] },
  { label: 'Graph updates',      hint: 'What reached the org graph',          path: '/iq/work/changes',                            tenant: 'orgiq',  group: 'Build', pageId: 'graph-updates',
    keywords: ['graph', 'changes', 'updates', 'merge', 'org graph'] },
  { label: 'Work Queue',         hint: 'Jobs and suggestions waiting on a dispatch', path: '/iq/work/queue',                       tenant: 'orgiq',  group: 'Build', pageId: 'work-queue',
    keywords: ['job', 'run', 'invocation', 'dispatch', 'queue', 'suggestion'] },
  { label: 'Findings',           hint: 'The dead-letter queue — what failed and why', path: '/iq/work/findings',                   tenant: 'orgiq',  group: 'Build', pageId: 'findings',
    keywords: ['finding', 'sweep', 'signal', 'dlq', 'dead letter', 'failure'] },
  { label: 'Initiatives',        hint: 'Epics, decisions, contributors',      path: '/iq/projects',                                tenant: 'orgiq',  group: 'Plan', pageId: 'initiatives',
    keywords: ['initiative', 'project', 'program', 'sprint', 'epic'] },
  { label: 'My work',            hint: 'Your open work items across every initiative', path: '/iq/my-work',                          tenant: 'orgiq',  group: 'Plan', pageId: 'my-work',
    keywords: ['my work', 'assigned', 'mine', 'my tasks', 'my items', 'todo', 'work items', 'story', 'bug'] },
  { label: 'Decisions',          hint: 'Calls made and calls waiting',        path: '/iq/decisions',                               tenant: 'orgiq',  group: 'Plan', pageId: 'decisions',
    keywords: ['decision', 'decide', 'escalated', 'adr', 'call', 'rationale', 'decider'] },
  { label: 'Agent library',            hint: 'Every prompt, system prompt and evaluator', path: '/iq/library',                          tenant: 'orgiq',  group: 'Build', pageId: 'agent-library',
    keywords: ['artifact', 'asset', 'library item', 'prompt', 'evaluator'] },
  { label: 'Designs',            hint: 'Design threads and sign-off',         path: '/iq/designs',                                 tenant: 'orgiq',  group: 'Design', pageId: 'designs',
    keywords: ['design', 'adr', 'decision', 'thread', 'sign-off', 'review'] },
  // Operate (lane E): this workspace's runs through the orgiq façade /api/runs,
  // gated like it (the bots read gate). "Workspace runs" in the palette so it
  // is not confused with Observability's "Runs" (agent invocations).
  { label: 'Workspace runs',     hint: 'Bot, agent and queue runs, with steps', path: '/iq/runs',                                  tenant: 'orgiq',  group: 'Operate', pageId: 'workspace-runs', roles: BOTS,
    keywords: ['run', 'runs', 'pipeline', 'bot', 'job', 'ledger', 'steps'] },
  // The day's work graph (/api/work-graph, requireTenant('orgiq') only — no
  // capability gate), so every orgiq role sees it, like Initiatives.
  { label: 'Work graph',         hint: 'The day as a graph, not the run ledger', path: '/iq/activity',                                tenant: 'orgiq',  group: 'Operate', pageId: 'work-graph',
    keywords: ['work graph', 'activity', 'graph', 'today', 'day', 'runs', 'work'] },
  { label: 'Budgets',            hint: 'Agent spend vs allocation',           path: '/admin/budgets',                              tenant: 'admin',  group: 'Plan', pageId: 'budgets',    roles: BUDGETS,
    keywords: ['budget', 'spend', 'allocation', 'money', 'grant', 'envelope'] },
  { label: 'Bots',               hint: 'Mission-configured cron bots',        path: '/admin/bots',                                 tenant: 'admin',  group: 'Build', pageId: 'bots',   roles: BOTS,
    keywords: ['bot', 'cron', 'mission', 'agent', 'schedule'] },
  { label: 'Codebases',          hint: 'Repos agents work on + runs',         path: '/admin/projects',                             tenant: 'admin',  group: 'Build', pageId: 'codebases',   roles: BUILD,
    keywords: ['codebase', 'repository', 'repo', 'git', 'run'] },
  { label: 'Changes',            hint: 'Code review queue + policies',        path: '/admin/changes',                              tenant: 'admin',  group: 'Build', pageId: 'changes',   roles: CHANGES,
    keywords: ['change', 'review', 'pr', 'pull request', 'diff', 'policy'] },
  // pageId: the voice navigator's `open` (page 'computers') opens this page, where computer start's machines appear.
  { label: 'Computers',          hint: 'Your machines and the lab\'s — hand them work', path: '/iq/computers',                      tenant: 'orgiq',  group: 'Build', pageId: 'computers',
    keywords: ['computer', 'machine', 'laptop', 'lab', 'local', 'paired', 'terminal', 'compute'] },
  { label: 'Runbooks',                hint: 'Procedures the fleet follows — read, version, review', path: '/iq/runbooks',    tenant: 'orgiq',  group: 'Build', pageId: 'runbooks',
    keywords: ['runbook', 'procedure', 'playbook', 'how to', 'steps', 'rollback', 'library', 'knowledge', 'guide', 'distillation', 'learned'] },
  { label: 'Runbook proposals',        hint: 'Edits and new runbooks waiting for a reviewer', path: '/iq/runbooks/proposals', tenant: 'orgiq',  group: 'Build', pageId: 'runbook-proposals',
    keywords: ['runbook', 'proposal', 'review', 'accept', 'reject', 'merge', 'diff', 'edit'] },
  { label: 'Recurring obstacles',      hint: 'Walls different runs keep hitting, with a runbook to write for each', path: '/iq/runbooks/obstacles', tenant: 'orgiq',  group: 'Build', pageId: 'runbook-obstacles', roles: BOTS,
    keywords: ['runbook', 'obstacle', 'blocked', 'wall', 'repeat', 'recurring', 'failed', 'run', 'learning'] },
  // ── Org — organizational intelligence ──
  { label: 'Search', hint: 'Find records, ask questions, explore connections', path: '/iq/search', tenant: 'orgiq', group: 'Engage', pageId: 'search',
    keywords: ['ask', 'search', 'chat', 'agent', 'help', 'explore', 'graph', 'connections'] },
  { label: 'Communication',      hint: 'Social channels and direct messages here, and the huddles you joined on initiative pages', path: '/iq/communication', tenant: 'orgiq', group: 'Engage', pageId: 'communication',
    keywords: ['communication', 'social', 'chat', 'message', 'dm', 'channel', 'mention', 'call', 'calls', 'huddle', 'missed', 'meeting', 'history'] },
  { label: 'Meetings',           hint: 'Minutes and transcripts of calls Nova listened to', path: '/iq/meetings',                                  tenant: 'orgiq',  group: 'Engage', pageId: 'meetings', feature: 'meetingAssistant',
    keywords: ['meeting', 'meetings', 'minutes', 'transcript', 'nova', 'notes', 'action items', 'summary', 'call notes'] },
  { label: 'Scores',             hint: 'Per-person influence leaderboard',    path: '/iq/scores',                                  tenant: 'orgiq',  group: 'Engage', pageId: 'scores', roles: PLATFORM,
    keywords: ['score', 'leaderboard', 'influence'] },
  { label: 'Score cohorts',      hint: 'Scores grouped by team',              path: '/iq/scores/cohorts',                          tenant: 'orgiq',  group: 'Engage', pageId: 'score-cohorts', roles: PLATFORM,
    keywords: ['score', 'cohort', 'team'] },
  { label: 'Score compare',      hint: 'Radar overlay of people',             path: '/iq/scores/compare',                          tenant: 'orgiq',  group: 'Engage', pageId: 'score-compare', roles: PLATFORM,
    keywords: ['score', 'compare', 'radar'] },
  // ── Operate — prompts, health, platform ──
  { label: 'What is deployed',   hint: 'Live prompts + what to do next',      path: '/iq/prompt-ops',                              tenant: 'orgiq',  group: 'Design', pageId: 'prompt-ops-deployed',  roles: PLATFORM,
    keywords: ['prompt', 'deployed', 'operations'] },
  { label: 'Studio',             hint: 'Author, type the contract, test',     path: '/iq/prompts',                                 tenant: 'admin',  group: 'Design', pageId: 'prompt-studio',  roles: PLATFORM,
    keywords: ['prompt', 'studio', 'author', 'contract', 'test'] },
  { label: 'Versions',           hint: 'Version log, diffs, past experiments', path: '/iq/history',                                 tenant: 'admin',  group: 'Design', pageId: 'prompt-versions',  roles: PLATFORM,
    keywords: ['version', 'history', 'diff', 'experiment'] },
  { label: 'Diff',               hint: 'Side-by-side prompt diff',            path: '/iq/diff',                                    tenant: 'admin',  group: 'Design', pageId: 'prompt-diff',  roles: PLATFORM,
    keywords: ['diff', 'compare', 'prompt', 'version'] },
  { label: 'Rollout',            hint: 'Canary A/B, weights, rollback',       path: '/iq/canary',                                  tenant: 'orgiq',  group: 'Design', pageId: 'prompt-rollout',  roles: PLATFORM,
    keywords: ['canary', 'rollout', 'ab', 'weight', 'rollback'] },
  { label: 'Evals',              hint: 'Judge configuration + pass rates',    path: '/iq/evaluations',                             tenant: 'admin',  group: 'Design', pageId: 'prompt-evals',  roles: PLATFORM,
    keywords: ['eval', 'evaluation', 'judge', 'pass rate'] },
  { label: 'Observability',      hint: 'Health, safety, runs and cost across the fleet', path: '/admin/observability/summary', tenant: 'admin', group: 'Operate', pageId: 'observability', roles: PLATFORM,
    keywords: ['observability', 'health', 'deployed', 'status', 'summary', 'monitoring'] },
  { label: 'On-Call',            hint: 'Live alarms + incident timeline',     path: '/admin/observability/oncall',                 tenant: 'admin',  group: 'Operate', pageId: 'observability-on-call', roles: PLATFORM,
    keywords: ['oncall', 'alarm', 'incident', 'timeline'] },
  { label: 'Runs',               hint: 'Last 50 agent runs',                  path: '/admin/observability/invocations',            tenant: 'admin',  group: 'Operate', pageId: 'observability-runs', roles: PLATFORM,
    keywords: ['run', 'invocation', 'dispatch', 'job'] },
  { label: 'Architecture',       hint: 'The agent fleet and how it connects', path: '/iq/agents',                                  tenant: 'admin',  group: 'Operate', pageId: 'agent-architecture', roles: PLATFORM,
    keywords: ['architecture', 'agent', 'fleet', 'topology'] },
  { label: 'Knowledge',          hint: 'Sources, ingestion, and the knowledge bases agents retrieve from', path: '/admin/knowledge', tenant: 'admin', group: 'Operate', pageId: 'knowledge', roles: PLATFORM,
    keywords: ['knowledge', 'source', 'ingestion', 'kb', 'knowledge base'] },
  { label: 'Ingest sources',     hint: 'What content is pulled in',           path: '/admin/ingest/crawl',                         tenant: 'admin',  group: 'Operate', pageId: 'ingest-sources', roles: BUILD,
    keywords: ['ingest', 'crawl', 'source'] },
  { label: 'Ingest runs',        hint: 'What each pull did',                  path: '/admin/ingest/history',                       tenant: 'admin',  group: 'Operate', pageId: 'ingest-runs', roles: BUILD,
    keywords: ['ingest', 'run', 'history'] },
  { label: 'Ingest storage',     hint: 'Where documents land',                path: '/admin/ingest/storage',                       tenant: 'admin',  group: 'Operate', pageId: 'ingest-storage', roles: BUILD,
    keywords: ['ingest', 'storage', 'document'] },
  { label: 'KB sync',            hint: 'Storage → knowledge base',            path: '/admin/ingest/sources',                       tenant: 'admin',  group: 'Operate', pageId: 'ingest-kb-sync', roles: BUILD,
    keywords: ['kb', 'sync', 'knowledge base', 'ingest'] },
  { label: 'Ingest schedule',    hint: 'How often it re-syncs',               path: '/admin/ingest/schedules',                     tenant: 'admin',  group: 'Operate', pageId: 'ingest-schedule', roles: BUILD,
    keywords: ['ingest', 'schedule', 'resync'] },
  { label: 'Capabilities',       hint: 'Guardrails, browser, interpreter',    path: '/admin/capabilities',                         tenant: 'admin',  group: 'Operate', pageId: 'capabilities', roles: PLATFORM,
    keywords: ['capabilities', 'guardrail', 'browser', 'interpreter'] },
  { label: 'Traffic',            hint: 'RPS + heatmap + top users',           path: '/admin/observability/traffic',                tenant: 'admin',  group: 'Operate', pageId: 'traffic', roles: PLATFORM,
    keywords: ['traffic', 'rps', 'heatmap'] },
  { label: 'Invocations Search', hint: 'Triage by prompt / agent / score',    path: '/admin/observability/invocations/search',     tenant: 'admin',  group: 'Operate', pageId: 'invocations-search', roles: PLATFORM,
    keywords: ['invocation', 'search', 'triage', 'run'] },
  { label: 'Capability Events',  hint: 'Browser & code-interpreter events',   path: '/admin/observability/capability-events',      tenant: 'admin',  group: 'Operate', pageId: 'capability-events', roles: PLATFORM,
    keywords: ['capability', 'event', 'browser', 'interpreter'] },
  { label: 'Tool Calls',         hint: 'Per-tool latency, volume, failures',  path: '/admin/observability/tools',                  tenant: 'admin',  group: 'Operate', pageId: 'tool-calls', roles: PLATFORM,
    keywords: ['tool', 'call', 'latency', 'volume'] },
  { label: 'Agent Metrics',      hint: 'Per-agent stats',                     path: '/admin/observability/agents',                 tenant: 'admin',  group: 'Operate', pageId: 'agent-metrics', roles: PLATFORM,
    keywords: ['agent', 'metric', 'stats'] },
  { label: 'Sessions',           hint: 'Chat threads',                        path: '/admin/observability/sessions',               tenant: 'admin',  group: 'Operate', pageId: 'sessions', roles: PLATFORM,
    keywords: ['session', 'chat', 'thread'] },
  { label: 'Authz Log',          hint: 'Live AVP / Cedar decisions',          path: '/admin/observability/authz',                  tenant: 'admin',  group: 'Operate', pageId: 'authz-log', roles: PLATFORM,
    keywords: ['authz', 'avp', 'cedar', 'decision'] },
  { label: 'Memory',             hint: 'Memory ops + cold sessions',          path: '/admin/observability/memory',                 tenant: 'admin',  group: 'Operate', pageId: 'memory', roles: PLATFORM,
    keywords: ['memory', 'cold session'] },
  { label: 'Guardrail Rules',    hint: 'Per-rule intervention details',       path: '/admin/observability/guardrail-rules',        tenant: 'admin',  group: 'Operate', pageId: 'guardrail-rules', roles: PLATFORM,
    keywords: ['guardrail', 'rule', 'intervention'] },
  { label: 'Drift',              hint: 'Schema + judge + embedding drift',    path: '/admin/observability/drift',                  tenant: 'admin',  group: 'Operate', pageId: 'drift', roles: PLATFORM,
    keywords: ['drift', 'schema', 'embedding'] },
  { label: 'Quality',            hint: 'Judge scores + feedback',             path: '/admin/observability/quality',                tenant: 'admin',  group: 'Operate', pageId: 'quality', roles: PLATFORM,
    keywords: ['quality', 'judge', 'feedback'] },
  { label: 'Cost',               hint: 'Spend by agent + deploy markers',     path: '/admin/observability/cost',                   tenant: 'admin',  group: 'Operate', pageId: 'cost', roles: PLATFORM,
    keywords: ['cost', 'spend', 'deploy marker', 'money'] },
  { label: 'Approval Queue',     hint: 'Pending HITL decisions',              path: '/admin/observability/approvals',              tenant: 'admin',  group: 'Operate', pageId: 'approval-queue', roles: PLATFORM,
    keywords: ['approval', 'hitl', 'pending', 'decision'] },
  { label: 'Harness',            hint: 'Replay test set + view runs',         path: '/admin/observability/harness',                tenant: 'admin',  group: 'Operate', pageId: 'harness', roles: PLATFORM,
    keywords: ['harness', 'replay', 'test set', 'run'] },
  { label: 'Calibration',        hint: 'Judge vs human MAE drift',            path: '/admin/observability/calibration',            tenant: 'admin',  group: 'Operate', pageId: 'calibration', roles: PLATFORM,
    keywords: ['calibration', 'judge', 'mae', 'drift'] },
  { label: 'Model Compare',      hint: 'Side-by-side run delta',              path: '/admin/observability/model-compare',          tenant: 'admin',  group: 'Operate', pageId: 'model-compare', roles: PLATFORM,
    keywords: ['model', 'compare', 'delta', 'run'] },
  // ── System — administration ──
  { label: 'Identity',           hint: 'Users, roles, Cedar policies',        path: '/admin/identity',                             tenant: 'admin',  group: 'System', pageId: 'identity',  roles: BUILD,
    keywords: ['identity', 'user', 'role', 'cedar', 'policy'] },
  { label: 'Identity Users',     hint: 'Provision users, tenants, role grants', path: '/admin/identity/users',                     tenant: 'admin',  group: 'System', pageId: 'identity-users',  roles: BUILD,
    keywords: ['identity', 'user', 'provision', 'tenant', 'role grant'] },
  { label: 'Policy sandbox',     hint: 'Dry-run an authz decision',           path: '/admin/identity/test',                        tenant: 'admin',  group: 'System', pageId: 'identity-policy-sandbox',  roles: BUILD,
    keywords: ['policy', 'sandbox', 'authz', 'dry-run', 'cedar'] },
  { label: 'Settings',           hint: 'User preferences',                    path: '/settings',                                   tenant: 'universal', group: 'System', pageId: 'settings',
    keywords: ['settings', 'preferences'] },
  { label: 'Logging',            hint: 'Voice sessions, agent runs, pipelines, jobs', path: '/iq/logging',                        tenant: 'orgiq',  group: 'System', pageId: 'system-logging', feature: 'voiceLog',
    keywords: ['logging', 'log', 'voice', 'session', 'transcript', 'history', 'tool call', 'agent run', 'bot run', 'invocation', 'pipeline', 'job', 'sweep', 'trace'] },
  // Assessment tenant — its own map (Assess / Analyze / Informatics / System),
  // mirroring NAV_ITEMS in Layout.tsx. Without these an assessment session's
  // palette listed nothing but Settings.
  { label: 'Dashboard',          hint: 'Cohorts, teams, scorecards',          path: '/assessment/teams',                           tenant: 'assessment', group: 'Assess', pageId: 'teams',
    keywords: ['dashboard', 'cohort', 'team', 'scorecard'] },
  { label: 'Communication',      hint: 'Social channels and direct messages here, and huddles on teams and documents', path: '/assessment/communication', tenant: 'assessment', group: 'Assess', pageId: 'communication',
    keywords: ['communication', 'social', 'chat', 'message', 'dm', 'channel', 'mention', 'call', 'calls', 'huddle', 'missed', 'meeting', 'history'] },
  { label: 'Submissions',        hint: 'Forms intake wizard',                 path: '/assessment/submissions',                     tenant: 'assessment', group: 'Assess', pageId: 'submissions',
    keywords: ['submission', 'form', 'intake'] },
  { label: 'Reports',            hint: 'Program rollup, where to start',      path: '/assessment/reports',                         tenant: 'assessment', group: 'Analyze', pageId: 'reports',
    keywords: ['report', 'rollup', 'certification', 'maturity', 'level'] },
  { label: 'Feedback',           hint: 'Open follow-ups across teams',        path: '/assessment/feedback',                        tenant: 'assessment', group: 'Analyze', pageId: 'feedback',
    keywords: ['feedback', 'follow-up'] },
  { label: 'Work graph',         hint: 'Teams, evidence and drafts for the day, not the run ledger', path: '/assessment/activity',                     tenant: 'assessment', group: 'Analyze', pageId: 'work-graph',
    keywords: ['activity', 'graph', 'teams', 'evidence', 'drafts', 'decks'] },
  { label: 'Enterprise',         hint: 'Governance context',                  path: '/assessment/enterprise',                      tenant: 'assessment', group: 'Informatics', pageId: 'enterprise',
    keywords: ['enterprise', 'governance'] },
  { label: 'Workspace',          hint: 'Documents, files and presentations',  path: '/assessment/workspace?view=library',          tenant: 'assessment', group: 'Informatics', pageId: 'workspace-library',
    keywords: ['workspace', 'document', 'file', 'explorer', 'deck', 'presentation', 'powerpoint', 'pptx', 'slides', 'review'] },
  { label: 'Prompts',            hint: 'Agent slash commands',                path: '/assessment/prompts',                         tenant: 'assessment', group: 'Informatics', pageId: 'prompts',
    keywords: ['prompt', 'slash command'] },
  { label: 'Rules',              hint: 'Scoring stance + archetypes',         path: '/assessment/rules',                           tenant: 'assessment', group: 'Informatics', pageId: 'rules',
    keywords: ['rules', 'scoring', 'archetype'] },
  { label: 'Activity',           hint: 'Agent run ledger',                    path: '/assessment/runs',                            tenant: 'assessment', group: 'System', pageId: 'runs',
    keywords: ['activity', 'run', 'agent', 'ledger'] },
  // Widened from ['program-lead'] — see ASSESSMENT_ROLES above. The page is
  // legitimately readable by every assessment role; only writes are gated.
  { label: 'Configuration',      hint: 'Motions, cohorts, target level',      path: '/assessment/configuration',                   tenant: 'assessment', group: 'System', pageId: 'assessment-configuration', roles: ASSESSMENT_ROLES,
    keywords: ['configuration', 'motion', 'cohort', 'target level', 'certification', 'maturity'] },
  // Social tenant — its own map (Talk / Meet / People / Library / System),
  // mirroring NAV_ITEMS in Layout.tsx. Every route is readable by every
  // social role (ViewSocial); writes are gated inside the pages.
  { label: 'Channels',           hint: 'Conversations the tenant shares',     path: '/social/channels',                            tenant: 'social', group: 'Talk', pageId: 'channels',
    keywords: ['channel', 'chat', 'conversation', 'message', 'thread'] },
  { label: 'Direct messages',    hint: 'One-to-one and small-group chats',    path: '/social/dms',                                 tenant: 'social', group: 'Talk', pageId: 'direct-messages',
    keywords: ['dm', 'direct message', 'private', 'chat'] },
  { label: 'Calls',              hint: 'Start or join a call',                path: '/social/calls',                               tenant: 'social', group: 'Meet', pageId: 'calls',
    keywords: ['call', 'video', 'audio', 'meet', 'ring'] },
  { label: 'Hangouts',              hint: 'Standing rooms you can drop into',    path: '/social/rooms',                               tenant: 'social', group: 'Meet', pageId: 'hangouts',
    keywords: ['room', 'hangout', 'huddle', 'meet'] },
  { label: 'Contacts',           hint: 'People you talk with',                path: '/social/contacts',                            tenant: 'social', group: 'People', pageId: 'contacts',
    keywords: ['contact', 'people', 'follow', 'presence'] },
  { label: 'Teams',              hint: 'Teams and their channels',            path: '/social/teams',                               tenant: 'social', group: 'People', pageId: 'teams',
    keywords: ['team', 'group', 'members'] },
  { label: 'Profile',            hint: 'How you appear to others here, and do not disturb', path: '/social/profile',               tenant: 'social', group: 'People', pageId: 'profile',
    keywords: ['profile', 'status', 'avatar', 'me', 'presence', 'away', 'busy', 'do not disturb'] },
  { label: 'Recordings',         hint: 'Call recordings and their shares',    path: '/social/recordings',                          tenant: 'social', group: 'Library', pageId: 'recordings',
    keywords: ['recording', 'video', 'playback', 'share'] },
  { label: 'Work graph',         hint: 'Your conversations, calls, recordings and decks for the day', path: '/social/work-graph', tenant: 'social', group: 'Library', pageId: 'work-graph',
    keywords: ['activity', 'graph', 'conversations', 'calls', 'recordings', 'decks', 'today'] },
  { label: 'Configuration',      hint: 'Retention, rooms and integrations',   path: '/social/configuration',                       tenant: 'social', group: 'System', pageId: 'social-configuration',
    keywords: ['configuration', 'retention', 'policy', 'integration'] },
  // Pipelines tenant — its own map (Catalog / Runs / Sources / System),
  // mirroring NAV_ITEMS in Layout.tsx. Every route is readable by every
  // pipelines role (ViewPipelines); writes are gated inside the pages.
  { label: 'Definitions',        hint: 'Pipeline definitions and versions',   path: '/pipelines/definitions',                      tenant: 'pipelines', group: 'Catalog', pageId: 'definitions',
    keywords: ['definition', 'pipeline', 'version', 'dag'] },
  { label: 'Workflows',          hint: 'Workflows awaiting a dry-run',        path: '/pipelines/workflows',                         tenant: 'pipelines', group: 'Catalog', pageId: 'workflows',
    keywords: ['workflow', 'runbook', 'dry-run', 'promotion'] },
  { label: 'Queues', hint: 'Backlog, in-flight work and dead-letter queues', path: '/pipelines/queues', tenant: 'pipelines', group: 'Runs', pageId: 'queues', keywords: ['queue', 'message-queue', 'backlog', 'dlq', 'realtime'] },
  { label: 'Runs',               hint: 'Every run, its steps and status',     path: '/pipelines/runs',                             tenant: 'pipelines', group: 'Runs', pageId: 'runs',
    keywords: ['run', 'job', 'execution', 'status', 'ledger'] },
  { label: 'Work graph',         hint: 'Runs, steps and approvals for the day, not the run ledger', path: '/pipelines/activity',                       tenant: 'pipelines', group: 'Runs', pageId: 'work-graph',
    keywords: ['activity', 'graph', 'runs', 'approvals'] },
  { label: 'Communication',      hint: 'Social channels and direct messages here, and huddles on runs', path: '/pipelines/communication', tenant: 'pipelines', group: 'Runs', pageId: 'communication',
    keywords: ['communication', 'social', 'chat', 'message', 'dm', 'channel', 'mention', 'call', 'calls', 'huddle', 'missed', 'meeting', 'history'] },
  { label: 'Approvals',          hint: 'Steps waiting on a person',           path: '/pipelines/approvals',                        tenant: 'pipelines', group: 'Runs', pageId: 'approvals',
    keywords: ['approval', 'approve', 'review', 'waiting'] },
  { label: 'Artifacts',          hint: 'What runs produced',                  path: '/pipelines/artifacts',                        tenant: 'pipelines', group: 'Runs', pageId: 'artifacts',
    keywords: ['artifact', 'change', 'document', 'trace', 'output'] },
  { label: 'Agents',             hint: 'Agent invocations as runs',           path: '/pipelines/agents',                           tenant: 'pipelines', group: 'Sources', pageId: 'agents',
    keywords: ['agent', 'invocation', 'fleet', 'source'] },
  { label: 'Bots',               hint: 'Scheduled bots as runs',              path: '/pipelines/bots',                             tenant: 'pipelines', group: 'Sources', pageId: 'bots',
    keywords: ['bot', 'cron', 'schedule', 'maintenance', 'source'] },
  { label: 'Commands',           hint: 'Assessment commands as runs',         path: '/pipelines/commands',                         tenant: 'pipelines', group: 'Sources', pageId: 'commands',
    keywords: ['command', 'assessment', 'source'] },
  // pipeline-admin only (separation of duties) — rail and route agree.
  { label: 'Configuration',      hint: 'Who approves a step by default',      path: '/pipelines/configuration',                    tenant: 'pipelines', group: 'System', pageId: 'pipelines-configuration', roles: ['pipeline-admin'],
    keywords: ['configuration', 'approver', 'default', 'policy'] },
  { label: 'Logging',            hint: 'Voice sessions and pipeline runs',    path: '/pipelines/logging',                          tenant: 'pipelines', group: 'System', pageId: 'system-logging', feature: 'voiceLog',
    keywords: ['logging', 'log', 'voice', 'session', 'transcript', 'history', 'tool call', 'pipeline', 'run', 'trace'] },
  // Access tenant — its own map (Request / Approve / Govern / System),
  // mirroring NAV_ITEMS in Layout.tsx. Request and Govern are readable by every
  // access role (ViewAccess); Approvals is DecideAccess (approver,
  // access-admin) and Configuration access-admin's, as the routes gate them.
  { label: 'Catalog',            hint: 'What access can be requested',        path: '/access/catalog',                             tenant: 'access', group: 'Request', pageId: 'catalog',
    keywords: ['catalog', 'entitlement', 'role', 'membership', 'request'] },
  { label: 'Requests',           hint: 'Your access requests and their chains', path: '/access/requests',                          tenant: 'access', group: 'Request', pageId: 'requests',
    keywords: ['request', 'elevation', 'status', 'mine', 'reports'] },
  { label: 'Open requests',      hint: 'Requests still waiting on an approver', path: '/access/requests?status=open',              tenant: 'access', group: 'Request', pageId: 'open-requests',
    keywords: ['open', 'pending', 'waiting', 'in progress', 'request'] },
  { label: 'New request',        hint: 'Ask for a role or a membership',      path: '/access/requests/new',                        tenant: 'access', group: 'Request', pageId: 'new-request',
    keywords: ['new', 'request', 'ask', 'elevate', 'grant', 'wizard'] },
  { label: 'Approvals',          hint: 'Requests waiting on your decision',   path: '/access/approvals',                           tenant: 'access', group: 'Approve', pageId: 'approvals', roles: ['approver', 'access-admin'],
    keywords: ['approval', 'approve', 'reject', 'inbox', 'decide', 'waiting'] },
  { label: 'Policies',           hint: 'Separation-of-duties rules',          path: '/access/policies',                            tenant: 'access', group: 'Govern', pageId: 'policies',
    keywords: ['policy', 'sod', 'separation of duties', 'conflict', 'rule'] },
  { label: 'Reviews',            hint: 'Access review campaigns',             path: '/access/reviews',                             tenant: 'access', group: 'Govern', pageId: 'reviews',
    keywords: ['review', 'certification', 'campaign', 'recertify'] },
  { label: 'Open reviews',       hint: 'Campaigns still waiting on decisions', path: '/access/reviews?status=open',               tenant: 'access', group: 'Govern', pageId: 'open-reviews',
    keywords: ['open', 'review', 'certify', 'keep', 'revoke', 'campaign'] },
  { label: 'Audit',              hint: 'Every request transition',            path: '/access/audit',                               tenant: 'access', group: 'Govern', pageId: 'audit',
    keywords: ['audit', 'event', 'history', 'log', 'trail'] },
  { label: 'Configuration',      hint: 'Durations, stewards and sensitive items', path: '/access/configuration',                     tenant: 'access', group: 'System', pageId: 'access-configuration', roles: ['access-admin'],
    keywords: ['configuration', 'duration', 'steward', 'sensitive'] },
  { label: 'Access settings',    hint: 'Your request notifications and views', path: '/access/settings',                           tenant: 'access', group: 'System', pageId: 'access-settings',
    keywords: ['settings', 'preferences', 'notifications'] },
];

const UUID_RE = /^[0-9a-f-]{36}$/i;

export function isPageVisible(page: PageEntry, tenant: string, role: string): boolean {
  if (page.tenant === 'universal') return true;
  // Platform pages (tenant 'admin') are org-tenant surfaces — same scoping as
  // the rail: a session parked on another tenant doesn't get org platform jumps.
  if (page.tenant === 'admin') {
    if (tenant !== 'orgiq') return false;
    if (role === 'admin') return true;
    return !page.roles || page.roles.includes(role);
  }
  if (page.tenant !== tenant) return false;
  if (role === 'admin') return true;
  return !page.roles || page.roles.includes(role);
}

// Recent harness runs for the palette's "Recent runs" group. The endpoint is
// an orgiq observability surface: from any other tenant it 403s, and the
// old hook refetched on every remount (its "loaded" flag was component
// state), so an assessment session logged a 403 on every navigation. Now
// gated on the tenant and cached at module level — one fetch per session
// per tenant, shared by every palette instance.
let harnessRunsCache: { tenant: string; runs: RecentRun[]; promise: Promise<RecentRun[]> | null } | null = null;

function fetchRecentHarnessRuns(tenant: string | null, role: string | null): Promise<RecentRun[]> {
  // Null = the session hasn't resolved yet. Defaulting that to orgiq is how
  // an assessment tab still fired (and 403'd) this request once per load.
  // The harness is a platform surface: a member could see real run rows in
  // the palette and be bounced away on selecting one (member audit #7).
  if (tenant !== 'orgiq') return Promise.resolve([]);
  if (role !== 'admin' && !PLATFORM.includes(role ?? '')) return Promise.resolve([]);
  if (harnessRunsCache?.tenant === tenant) {
    return harnessRunsCache.promise ?? Promise.resolve(harnessRunsCache.runs);
  }
  const entry = { tenant, runs: [] as RecentRun[], promise: null as Promise<RecentRun[]> | null };
  harnessRunsCache = entry;
  entry.promise = fetch('/api/observability/harness/runs?limit=5', { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: unknown) => {
      const raw = j == null ? [] : Array.isArray(j) ? j : ((j as { runs?: unknown }).runs ?? []);
      const list = Array.isArray(raw) ? (raw as RecentRun[]) : [];
      entry.runs = list.slice(0, 5);
      return entry.runs;
    })
    .catch(() => entry.runs)
    .finally(() => { entry.promise = null; });
  return entry.promise;
}

/** Test seam: forget the cached runs (a sign-out / tenant switch hard-navigates anyway). */
export function resetRecentHarnessRunsCache(): void { harnessRunsCache = null; }

function useRecentHarnessRuns(tenant: string | null, role: string | null): RecentRun[] {
  const [runs, setRuns] = useState<RecentRun[]>(() => (harnessRunsCache?.tenant === tenant ? harnessRunsCache.runs : []));

  useEffect(() => {
    let cancelled = false;
    void fetchRecentHarnessRuns(tenant, role).then((list) => { if (!cancelled) setRuns(list); });
    return () => { cancelled = true; };
  }, [tenant, role]);

  return runs;
}

/**
 * Composes the static page-jump catalog (tenant/role-filtered) with recent
 * harness runs into a single Command[] suitable for the CommandPalette.
 */
export function usePortalCommands(): Command[] {
  const navigate = useNavigate();
  const { session } = useSession();
  const tenant = session?.tenant ?? 'orgiq';
  const role = session?.role ?? 'member';
  const runs = useRecentHarnessRuns(session?.tenant ?? null, session?.role ?? null);

  return useMemo<Command[]>(() => {
    // Stable sort: the tenant's rail order between groups, definition order
    // within one — so the palette never leads with Settings.
    // A page this role cannot open is offered only when the session holds a role that opens it, and then says
    // so: the jump lands on the page's "no access" state, which makes the switch (lib/pageAccess.ts). The rail
    // does not: it lists only what the current role opens (Layout.tsx).
    const switchTo = (p: PageEntry): string | null =>
      isPageVisible(p, tenant, role) || !isPageVisible(p, tenant, 'admin') ? null : offerPage(session, p.roles).switchTo;
    const pageCommands: Command[] = PAGES
      .filter((p) => (isPageVisible(p, tenant, role) || switchTo(p) != null) && (!p.feature || (p.feature === 'meetingAssistant' ? meetingsAdvertised(session) : features[p.feature])))
      .sort((a, b) => groupRank(tenant, a.group) - groupRank(tenant, b.group))
      .map((p) => ({
        id: `page:${p.path}`,
        label: p.label,
        hint: switchTo(p) ? `Switch to ${switchTo(p)} to open · ${p.hint}` : p.hint,
        group: p.group,
        // Path stays in the list (paste-a-URL-fragment still matches); the
        // per-page keywords carry the words people type; and the hint's own
        // words are folded in, because the palette RENDERS the hint and used
        // to find nothing when the reader typed a word off it. See
        // commandKeywords.ts.
        keywords: commandKeywords(p.path, p.label, p.keywords, p.hint),
        run: () => { navigate(p.path); },
      }));

    const runCommands: Command[] = runs.map((r) => ({
      id: `run:${r.runId}`,
      label: `Run · ${r.label ?? r.runId}`,
      hint: `${r.status ?? 'run'} · ${r.runId.slice(0, 8)}`,
      group: 'Recent runs',
      keywords: [r.runId, 'run', 'harness'],
      run: () => { navigate(`/admin/observability/harness/runs/${r.runId}`); },
    }));

    return [...pageCommands, ...runCommands];
  }, [navigate, tenant, role, runs, session]);
}

/**
 * Query-derived commands: when the user pastes a UUID, surface a single
 * synthetic "Open invocation" command that jumps to the invocation detail.
 */
export function usePortalDynamicCommands(): (query: string) => Command[] {
  const navigate = useNavigate();
  const { session } = useSession();
  // Optional: the palette is mounted inside ComputeHost, but a test or a
  // story may render the shell without it, and losing the terminal commands is
  // better than throwing on a missing provider.
  const compute = useComputeOptional();
  const boxes = compute?.computers ?? [];

  return useCallback((query: string): Command[] => {
    const q = query.trim();

    // Terminals from anywhere. The dock has hotkeys, but a hotkey cannot open
    // the FIRST shell — you have to pick a box — and the palette is where this
    // app already puts "do a thing without navigating".
    const wantsShell = /^(term|shell|tty|ssh|console)/i.test(q);
    if (wantsShell || q === '') {
      const shellCommands: Command[] = boxes.map((b) => ({
        id: `shell:${b.id}`,
        label: `Terminal → ${b.label}`,
        hint: 'open a shell in this computer',
        group: 'Terminals',
        keywords: ['terminal', 'shell', 'tty', 'console', b.label, b.id],
        run: () => { openShell({ id: b.id, label: b.label, sessionId: b.sessionId }); },
      }));
      if (boxes.length === 0 && wantsShell) {
        shellCommands.push({
          id: 'shell:none',
          label: 'No computers yet — open Computers to create one',
          hint: 'a terminal needs a computer to attach to',
          group: 'Terminals',
          keywords: ['terminal', 'shell'],
          run: () => { navigate('/iq/computers'); },
        });
      }
      if (wantsShell) return shellCommands;
      if (shellCommands.length) return shellCommands;
    }

    if (!UUID_RE.test(q)) return q && session?.tenant === 'orgiq' ? [{
      id: `workspace-search:${q}`, label: `Search workspace: ${q}`, group: 'Search',
      hint: 'Results, answers, and connections', keywords: [q, 'search'],
      run: () => { navigate(`/iq/search?${new URLSearchParams({ q, tab: 'results' })}`); },
    }] : [];
    const prefix = q.slice(0, 8);
    return [
      {
        id: `uuid:${q}`,
        label: `Open invocation ${prefix} →`,
        hint: q,
        group: 'Direct jump',
        // Seed keywords with the query itself so cmdk's matcher doesn't drop it.
        keywords: [q, prefix, 'invocation', 'uuid'],
        run: () => { navigate(`/admin/observability/invocations/${q}`); },
      },
    ];
  }, [navigate, boxes, session?.tenant]);
}
