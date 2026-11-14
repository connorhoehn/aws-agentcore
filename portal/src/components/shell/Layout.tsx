import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { meetingsAdvertised } from '../../lib/meetingAssistantModel';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import {
  CommandPalette,
  CommandPaletteHint,
  CommandPaletteProvider,
  DropdownMenu,
  Inline,
  Stack,
  SubNavLayout,
  type SubNavItem,
  SkipLink,
  type Command,
  type PaletteRecord,
  activeNavItemClassName,
  inactiveNavItemClassName,
  RAIL_CURRENT_FILL,
  ChevronIcon,
  IconButton,
  MenuIcon,
  RAIL_FOLD_PRIMARY_BELOW,
  RAIL_FOLD_SECTION_BELOW,
  RailBandProvider,
  railBand,
  railDepth,
  useRailFold,
  useViewportWidth,
  type RailDepthSpec,
} from '@connorhoehn/ui-components/shared';
import { DockedColumn, SidePaneProvider, useSidePaneHost } from '@connorhoehn/ui-components';
import { useDialogueRailFold } from './useDialogueRailFold';
import { ConversationInputProvider } from '@connorhoehn/ui-components/social/rich-composer';

// activeNavItemClassName / inactiveNavItemClassName come from the library, not
// from local copies. They were briefly replaced with local strings on the
// premise that "ui-components 2.276.0 removed some exports" — checked against
// the installed dist and that is not so: the pin is 2.277.2 and both names
// resolve from `/shared`. The local copies were also not equivalent. The real
// active class is
// `block px-[14px] py-2 border-l-[3px] border-primary bg-surface-hover text-text-primary …`;
// the substitute was `font-semibold text-foreground`, which drops the left
// accent bar, the highlight and ALL the padding, and names tokens this app does
// not define (`text-foreground` appears in 2 files here, `text-text-primary` in
// 101). Measured on the shell rail with the substitute in place: borderLeft 0px,
// background transparent, padding 0px — every rail item flush to the edge with
// no active state. Seven other layouts never stopped importing these, so the
// rails had also stopped agreeing with each other.
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { useSession } from '../../lib/auth';
import { Breadcrumbs } from './Breadcrumbs';
import { AmbientVisitorTargets } from '../ambient/AmbientVisitor';
import { TenantSwitcher } from './TenantSwitcher';
import { MasqueradeMenu } from './MasqueradeMenu';
import { FleetIndicator } from './FleetIndicator';
import { ActivityBell } from './ActivityBell';
import { useOrgiqShellPolls, useRefreshSessionOnDeny } from './orgiqShellPolls';
import { usePortalCommands, usePortalDynamicCommands, groupRank } from './portalCommands';
import { createPaletteRecordSearch, isAppPath } from '../../lib/paletteRecords';
import { useDiscussionUnread } from './useDiscussionUnread';
import { useSharedNotifications } from './SharedNotifications';
import { navigationActivity } from './navActivity';
import { discussionCommandLabel, railCount } from './discussionUnreadModel';
import { DevboxQuickSwitch, type PaletteScope } from './DevboxQuickSwitch';
import { ToastHost } from './ToastHost';
import { ComputeDock } from '@connorhoehn/ui-components/compute';
import { features, tenantEnabled } from '../../lib/features';
import { ShellCallHost } from './ShellCallHost';
import { CallBlock } from '../../lib/conversationCall';
import { EmbeddedSocialProvider } from './EmbeddedSocial';
import { TodayPlacementProvider, TodayStripSlot } from './FooterTodayStrip';
import { SocialFooter } from './SocialFooter';
import { HuddleChatSplit } from './HuddleChat';
import { MeetingRoomBanner } from './CallMeeting';
import { healthFailed, healthPending, type DependencyHealth } from '../../lib/healthStatus';

interface Health {
  status: string;
  service: string;
  mocks: Record<string, boolean>;
  region: string;
  awsCredentials?: DependencyHealth;
  datastore?: DependencyHealth;
}

interface WorkSummary {
  jobs: Record<string, number>;
  proposals: Record<string, number>;
  findings: { open: number; critical: number; warning: number };
}

type Tenant = 'orgiq' | 'assessment' | 'social' | 'pipelines' | 'access' | 'admin';
type NavItem = { path: string; label: string; requireRoles?: string[]; tenant: Tenant | 'universal'; group?: string; /** Listed only while the server advertises the meeting assistant. */ needsMeetingAssistant?: boolean };

// The app is an SDLC agent platform first — agents that link codebases, run in
// computers, and deliver reviewed changes. The rail IS the SDLC, phase by
// phase: PLAN (what and why — initiatives, sprints-as-a-lens, the money) →
// DESIGN (what the agents know and how they behave — prompts, knowledge) →
// BUILD (the machinery doing the work — queue, bots, computer lab, codebases)
// → RELEASE (what ships — change review today, pipelines eventually) →
// OPERATE (is it healthy) — then ORG (the people layer) and SYSTEM. The same
// hierarchy serves every role; a role simply sees fewer doors per phase
// (an SME gets Build without Codebases, a program owner gets Plan + Release
// without Identity), so an SME and a PM are always looking at one map.


// The palette's hint is the tenant's own vocabulary — "invocation id" and
// "runs" mean nothing to an assessor.
const PALETTE_PLACEHOLDER: Record<string, string> = {
  orgiq: 'Jump to a page, paste an invocation id, search runs…',
  assessment: 'Jump to a page, find a team (TEAM-0NN) or a command…',
  social: 'Jump to a channel, a call, a room or a person…',
  pipelines: 'Jump to a run, a definition or an approval…',
  access: 'Jump to a request (req-0001), the catalog or an approval…',
};

// ⌘I scopes the same ⌘K dialog down to just the Devbox group (see
// DevboxQuickSwitch's own comment on why there's no real pre-filtered-dialog
// API to open instead). The placeholder used to stay the tenant default even
// while scoped, advertising "paste an invocation id, search runs…" search
// that scope isn't offering — every one of those commands is hidden.
const DEVBOX_PALETTE_PLACEHOLDER = 'Search computers, or + New computer…';

// Tenant/universal items (visible per tenant + role, not just to admins).
const NAV_ITEMS: NavItem[] = [
  // Plan's front door. Sprints are a lens on this page (?lens=sprints), not a
  // sibling item — a sprint is one initiative's iteration.
  { path: '/iq/projects',   label: 'Initiatives', tenant: 'orgiq',     group: 'Plan' },
  // Your own open work across every initiative: a flat table, so no section rail.
  { path: '/iq/my-work',    label: 'My work',     tenant: 'orgiq',     group: 'Plan' },
  { path: '/iq/decisions',  label: 'Decisions',   tenant: 'orgiq',     group: 'Plan' },
  // ONE Build door for the whole agentic loop. "Automate" opens on the
  // overview; its sub-rail carries Queue, Findings (DLQ), Bots and Changes —
  // work is automated by a bot configuration on a queue, and when it needs a
  // human it lands in review. Every signed-in role can read the loop.
  { path: '/iq/work',       label: 'Automate',    tenant: 'orgiq',     group: 'Build' },
  // The other half of the loop: Automate is what the fleet DOES, Runbooks is
  // what it LEARNED — procedures a person can read, that a booted box receives.
  { path: '/iq/runbooks', label: 'Runbooks', tenant: 'orgiq',   group: 'Build' },
  { path: '/iq/library', label: 'Agent library', tenant: 'orgiq', group: 'Build' },
  // One door for every computer an agent can work on: the paired machines and the lab's (lane E5).
  { path: '/iq/computers', label: 'Computers', tenant: 'orgiq', group: 'Build' },
  { path: '/iq/search',     label: 'Search',         tenant: 'orgiq',     group: 'Engage' },
  // Communication: the Social plane embedded in orgiq, with the call log as its Calls shelf. Every orgiq role
  // (Social reads gate on the Social grant at the BFF; no grant → the plane's own denied state).
  { path: '/iq/communication', label: 'Communication', tenant: 'orgiq',  group: 'Engage' },
  // The minutes and transcripts of calls Nova listened to; a flat table of the viewer's own meetings, so no section rail.
  { path: '/iq/meetings',   label: 'Meetings',    tenant: 'orgiq',     group: 'Engage', needsMeetingAssistant: true },
  // Ask is also the "find help" surface: its empty state offers questions
  // from your own work, and answers grow an evidence rail (people + matched
  // skills + documents, score-free) via /api/graph/help. Scores stays the
  // separate HR analytics view — ViewLeaderboard tier, leadership only; an
  // ungated nav item just handed every SME a 403'd leaderboard.
  { path: '/iq/scores',     label: 'Scores',      tenant: 'orgiq',     group: 'Engage', requireRoles: ['org-leader', 'hr-admin'] },
  // Initiative design discussions remain separate from reusable assets.
  { path: '/iq/designs', label: 'Designs', tenant: 'orgiq', group: 'Design' },
  // OPERATE — the runs this workspace produced (bots, agents, the queue),
  // read through the orgiq façade /api/runs (docs/social-tenant-design.md
  // §5.1). Gated like the façade — the bots read gate: org-leader, hr-admin,
  // program-owner, plus ManageBots (sme) — so the rail is not narrower than
  // the API (docs/nav-server-tier-decisions.md). `admin` listed: no bypass here.
  { path: '/iq/runs', label: 'Runs', tenant: 'orgiq', group: 'Operate', requireRoles: ['sme', 'program-owner', 'org-leader', 'hr-admin', 'admin'] },
  // Release: the session bundle every devbox Claude Code session boots with.
  // The assessment tenant is a different product with a different map: not
  // the SDLC arc but the assessment programme's own — ASSESS (the intake and
  // scoring cockpit) → ANALYZE (what the scores say across teams) →
  // INFORMATICS (the knowledge the assessors and agents work from) → SYSTEM.
  // These are the shell rail for that tenant, grouped under its own kickers,
  // exactly as the source app's sidebar is — there is no second rail inside.
  { path: '/assessment/teams',         label: 'Dashboard',     tenant: 'assessment', group: 'Assess' },
  { path: '/assessment/submissions',   label: 'Submissions',   tenant: 'assessment', group: 'Assess' },
  // Communication: the Social plane, with team/document huddles as its Calls shelf; every assessment role, so no roles.
  { path: '/assessment/communication', label: 'Communication', tenant: 'assessment', group: 'Assess' },
  { path: '/assessment/reports',       label: 'Reports',       tenant: 'assessment', group: 'Analyze' },
  { path: '/assessment/feedback',      label: 'Feedback',      tenant: 'assessment', group: 'Analyze' },
  // The activity graph: ViewAssessment, which every assessment role holds (route and API), so no roles.
  { path: '/assessment/activity',      label: 'Work graph',     tenant: 'assessment', group: 'Analyze' },
  { path: '/assessment/enterprise',    label: 'Enterprise',    tenant: 'assessment', group: 'Informatics' },
  { path: '/assessment/workspace',     label: 'Workspace',     tenant: 'assessment', group: 'Informatics' },
  { path: '/assessment/prompts',       label: 'Prompts',       tenant: 'assessment', group: 'Informatics' },
  { path: '/assessment/rules',         label: 'Rules',         tenant: 'assessment', group: 'Informatics' },
  { path: '/assessment/runs',          label: 'Activity',      tenant: 'assessment', group: 'System' },
  // Every assessment role may READ this — `GET /configuration` is gated
  // `ViewAssessment`, which all three hold, and the page disables every input
  // and hides Save behind `canManage` (program-lead only). The palette was
  // widened to all three when that was settled; this rail entry was not, so
  // an assessor could reach the page by ⌘K or URL and see it render, while
  // the rail insisted it did not exist. `admin` is listed explicitly because
  // the tenant-nav filter has no admin bypass (the PLATFORM_ITEMS one does).
  { path: '/assessment/configuration', label: 'Configuration', tenant: 'assessment', group: 'System',
    requireRoles: ['program-lead', 'assessor', 'lead-assessor', 'admin'] },
  // The social tenant's own map (docs/social-tenant-design.md §4.1): TALK
  // (channels, DMs) → MEET (calls, rooms) → PEOPLE → LIBRARY (recordings) →
  // SYSTEM. Every social role reads every page (ViewSocial); writes are gated
  // inside them, so no row names roles.
  { path: '/social/dms',           label: 'Direct messages', tenant: 'social', group: 'Talk' },
  { path: '/social/channels',      label: 'Channels',        tenant: 'social', group: 'Talk' },
  { path: '/social/calls',         label: 'Calls',           tenant: 'social', group: 'Meet' },
  { path: '/social/rooms',         label: 'Hangouts',           tenant: 'social', group: 'Meet' },
  { path: '/social/contacts',      label: 'Contacts',        tenant: 'social', group: 'People' },
  { path: '/social/teams',         label: 'Teams',           tenant: 'social', group: 'People' },
  { path: '/social/profile',       label: 'Profile',         tenant: 'social', group: 'People' },
  { path: '/social/recordings',    label: 'Recordings',      tenant: 'social', group: 'Library' },
  // The work graph: ViewSocial, which every social role holds (route and API), so no roles.
  { path: '/social/work-graph',       label: 'Work graph',      tenant: 'social', group: 'Library' },
  { path: '/social/configuration', label: 'Configuration',   tenant: 'social', group: 'System' },
  // The pipelines tenant's own map (docs/social-tenant-design.md §5.3):
  // CATALOG (what can run) → RUNS (what ran, what waits on a person, what it
  // produced) → SOURCES (the three producers) → SYSTEM. Every pipelines role
  // reads every page (ViewPipelines).
  { path: '/pipelines/definitions',   label: 'Definitions',   tenant: 'pipelines', group: 'Catalog' },
  { path: '/pipelines/workflows',     label: 'Workflows',     tenant: 'pipelines', group: 'Catalog' },
  { path: '/pipelines/queues', label: 'Queues', tenant: 'pipelines', group: 'Runs' },
  { path: '/pipelines/runs',          label: 'Runs',          tenant: 'pipelines', group: 'Runs' },
  { path: '/pipelines/activity',      label: 'Work graph',    tenant: 'pipelines', group: 'Runs' },
  { path: '/pipelines/approvals',     label: 'Approvals',     tenant: 'pipelines', group: 'Runs' },
  // Communication: the Social plane, with run huddles as its Calls shelf; every pipelines role, so no roles.
  { path: '/pipelines/communication', label: 'Communication', tenant: 'pipelines', group: 'Runs' },
  { path: '/pipelines/artifacts',     label: 'Artifacts',     tenant: 'pipelines', group: 'Runs' },
  { path: '/pipelines/agents',        label: 'Agents',        tenant: 'pipelines', group: 'Sources' },
  { path: '/pipelines/bots',          label: 'Bots',          tenant: 'pipelines', group: 'Sources' },
  { path: '/pipelines/commands',      label: 'Commands',      tenant: 'pipelines', group: 'Sources' },
  // pipeline-admin only: author and operator never see Configuration (the
  // separation-of-duties table, docs/pipelines-tenant-goal.md). `admin` is
  // listed because the tenant-nav filter has no admin bypass.
  ...(features.voiceLog ? [{ path: '/pipelines/logging', label: 'Logging', tenant: 'pipelines' as const, group: 'System' }] : []),
  { path: '/pipelines/configuration', label: 'Configuration', tenant: 'pipelines', group: 'System', requireRoles: ['pipeline-admin', 'admin'] },
  // The access tenant's own map (docs/access-tenant-design.md §6): REQUEST
  // (what can be asked for, what you asked for) → APPROVE (what waits on you)
  // → GOVERN (the SoD rules, reviews, the audit trail) → SYSTEM. Every access
  // role reads Request and Govern (ViewAccess). Approvals reads
  // GET /api/access/approvals, gated DecideAccess (approver, access-admin);
  // Configuration is access-admin's (ManageAccessCatalog). `admin` is listed
  // because the tenant-nav filter has no admin bypass.
  { path: '/access/catalog',       label: 'Catalog',       tenant: 'access', group: 'Request' },
  { path: '/access/requests',      label: 'Requests',      tenant: 'access', group: 'Request' },
  { path: '/access/approvals',     label: 'Approvals',     tenant: 'access', group: 'Approve', requireRoles: ['approver', 'access-admin', 'admin'] },
  { path: '/access/policies',      label: 'Policies',      tenant: 'access', group: 'Govern' },
  { path: '/access/reviews',       label: 'Reviews',       tenant: 'access', group: 'Govern' },
  { path: '/access/audit',         label: 'Audit',         tenant: 'access', group: 'Govern' },
  { path: '/access/configuration', label: 'Configuration', tenant: 'access', group: 'System', requireRoles: ['access-admin', 'admin'] },
  { path: '/settings',      label: 'Settings',    tenant: 'universal', group: 'System' },
  // Logging (G37; the voice sessions of G20 are one source): dev server + the voice navigator flag, like its route.
  ...(features.voiceLog ? [{ path: '/iq/logging', label: 'Logging', tenant: 'orgiq' as const, group: 'System' }] : []),
];

// Platform/admin surfaces, gated by role and grouped SDLC-first.
const PLATFORM_ITEMS: NavItem[] = [
  // PLAN — the money that funds the plan. Budgets renders directly after
  // Initiatives (in NAV_ITEMS above): the allocation ledger sits beside the
  // initiatives it funds. Read-wide (org-leader + hr-admin); writes are
  // capability-gated inside the page.
  { path: '/admin/budgets',         label: 'Budgets',         tenant: 'admin', requireRoles: ['org-leader', 'hr-admin', 'program-owner'], group: 'Plan' },
  // BUILD — the SDLC core: the repos and the machines agents run on. Bots and
  // Changes are NOT here: they are children of the Automate door above
  // (pages/work/automateNav.tsx), not top-level destinations.
  // 'Codebases', not 'Projects': /iq/projects is already the org's initiatives —
  // epics, features, the people who own them. This is the code that delivers them.
  // Session configuration lives beneath Local compute, not in a separate
  // Release group. Change review lives under Automate.
  { path: '/admin/projects',        label: 'Codebases',       tenant: 'admin', requireRoles: ['hr-admin'], group: 'Build' },
  // OPERATE — platform + ops.
  { path: '/admin/observability',   label: 'Observability',   tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'], group: 'Operate' },
  { path: '/iq/agents',             label: 'Architecture',    tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'], group: 'Operate' }, // matches the route guard in App.tsx
  // One entry, not two: sources, ingestion, storage and knowledge bases are
  // consecutive stages of one pipeline. Operate, not Design: the page is the
  // running pipeline — sources pulled, ingestion runs, registry vs the live
  // account — and the palette and the breadcrumb already said so; the rail
  // was the odd one out.
  { path: '/admin/knowledge',       label: 'Knowledge',       tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'], group: 'Operate' },
  { path: '/admin/capabilities',    label: 'Capabilities',    tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'], group: 'Operate' },
  // SYSTEM — administration, not runtime. Identity sits with Settings: who can
  // do what is configuration of the platform, not operating it.
  { path: '/admin/identity',        label: 'Identity',        tenant: 'admin', requireRoles: ['hr-admin'], group: 'System' },
];

const TENANT_LABELS: Record<Tenant, string> = {
  orgiq: 'Work',
  assessment: 'Assessment',
  social: 'Social',
  pipelines: 'Pipelines',
  access: 'Access',
  admin: 'Admin',
};

/**
 * How deep a route sits (docs/layout-cascade.md rule 8), declared for the
 * library rail model (`railDepth`): the tenant prefixes, the query params that
 * open a record beside a page's list (a selection is one level below its
 * page), and the records that are always deep — a run, a document opened from
 * its source, a deck, a catalog record open beside its list rail. A side pane
 * exploring a selection (an initiative's Details/Log, Search's Ask about
 * selection) is two more levels: the library pane host says so.
 */
const SHELL_RAIL_DEPTH: RailDepthSpec = {
  prefixes: ['iq', 'assessment', 'social', 'pipelines', 'access', 'admin'],
  drillParams: ['item', 'dimension', 'step', 'sample', 'run', 'candidate'],
  leafRoutes: [
    /^\/(iq|pipelines)\/runs\/[^/]+$/,
    // Logging always draws its list rail, empty or not: one band, so the primary rail does not jump between the two.
    /^\/(iq|pipelines)\/logging(\/|$)/,
    /^\/iq\/documents\/[^/]+$/,
    /^\/(iq|assessment|social|pipelines)\/decks\/[^/]+$/,
    /^\/iq\/(designs|library|decisions)\/[^/]+$/,
    /^\/iq\/runbooks\/(?!proposals$|briefs$)[^/]+$/,
    /^\/iq\/runbooks\/(proposals|briefs)\/[^/]+$/,
    /^\/assessment\/(submissions|feedback|runs)\/[^/]+$/,
    /^\/pipelines\/(definitions|approvals)\/[^/]+$/,
    /^\/access\/policies\/[^/]+$/,
    /^\/admin\/ingest\/(crawl|history)\/[^/]+$/,
    /^\/admin\/identity\/users\/[^/]+$/,
    /^\/social\/contacts\/[^/]+$/,
  ],
};

/** The shell's right pane host (library `SidePaneProvider`) sits above the rails, so the rail rule can read it. */
export function Layout() {
  return <SidePaneProvider storageKey="shell.conversation-pane" bounds={{ minSecondaryPx: 480, fitPrimaryPx: 640 }}><ShellLayout /></SidePaneProvider>;
}

function ShellLayout() {
  const { session } = useSession();
  const { data: health } = useFetch<Health>('/api/health', 30_000);
  // /api/work is orgiq-only (requireTenant('orgiq')); polling it from an
  // out-of-tenant session logged a DENY in the authz audit every 15s. Gated on
  // the capability probe too, not the session alone (orgiqShellPolls.ts).
  const orgiqPolls = useOrgiqShellPolls();
  const { data: work, error: workError } = useFetch<WorkSummary>(
    orgiqPolls ? '/api/work/summary' : null, 15_000);
  useRefreshSessionOnDeny(workError);
  // Open runbook proposals this person may decide: only a role that holds the review capability asks.
  const { can: canDo } = useCapabilities();
  const { data: runbookReviews } = useFetch<{ count: number }>(
    orgiqPolls && canDo('ReviewRunbook') ? '/api/runbooks/proposals/review-count' : null, 30_000);
  const location = useLocation();
  const { pathname } = location;
  // Which rail gives way on a deep page (the library rail model): from three
  // levels down the primary rail folds to its strip and the section rail
  // stays open; narrow windows fold the primary first, the section second.
  // The reader's own toggle wins, remembered per device per depth band.
  const sidePane = useSidePaneHost();
  const depth = railDepth(location, { ...SHELL_RAIL_DEPTH, explored: sidePane.explored });
  const band = railBand(depth);
  const viewportWidth = useViewportWidth();
  // A phone (under 40rem): the header is ONE row — the navigation menu as an icon, the brand, then the search
  // icon, the fleet's status dot, the bell and the person's avatar. Before, the brand, the Navigation / Search /
  // fleet row and the persona chip wrapped onto three rows (~220px above the content at 390).
  const phoneHeader = viewportWidth < 640;
  const primaryRail = useRailFold({ storageKey: 'shell.primary-rail', band, defaultFolded: band === 'deep' || viewportWidth < RAIL_FOLD_PRIMARY_BELOW });
  const [huddleDialogueOpen, setHuddleDialogueOpen] = useState(false);
  const dialogueRail = useDialogueRailFold(sidePane.shown || huddleDialogueOpen, primaryRail, pathname);
  const rails = {
    primary: dialogueRail.folded ? 'collapsed' : 'open',
    section: viewportWidth < RAIL_FOLD_SECTION_BELOW ? 'collapsed' : 'open',
    depth,
    togglePrimary: dialogueRail.toggle,
  } as const;
  const navigate = useNavigate();

  // Routes that render their own SubNavLayout (iq/admin) go
  // full-bleed — the outer p-6 was double-framing them and wasting a 24px
  // ring of content space around every nested layout. Standalone pages
  // (settings, etc.) keep the comfortable padding.
  // One content padding, everywhere: ui-components' SubNavLayout pads its own
  // <main> (24px) and app.css zeroes only the NESTED section layouts' mains
  // (they inherit the shell's), so this column adds none — the old full-bleed
  // list existed to avoid double-padding nested rails and is not needed.
  const rawCommands = usePortalCommands();
  const rawGetDynamicCommands = usePortalDynamicCommands();

  // The palette has exactly one built-in hotkey (⌘K). DevboxQuickSwitch's
  // ⌘I command narrows the same dialog to its own "Devbox" group by asking
  // every OTHER command (static pages + query-derived ones) to hide for as
  // long as it's scoped — the closest a single-palette API gets to "open
  // pre-filtered to a group". Devbox's own commands are registered directly
  // into the palette via useRegisterCommand, so they're untouched by this.
  const [paletteScope, setPaletteScope] = useState<PaletteScope>('all');
  // The record section (ui-components 2.457.0): one search per tenant, a stable reference per tenant.
  const recordSearch = useMemo(() => createPaletteRecordSearch(session?.tenant ?? 'orgiq'), [session?.tenant]);
  const openRecord = useCallback((record: PaletteRecord) => { if (isAppPath(record.href)) navigate(record.href); }, [navigate]);
  const scopeCommand = useCallback(
    (c: Command): Command => ({
      ...c,
      when: () => (paletteScope === 'devbox' ? false : (c.when ? c.when() : true)),
    }),
    [paletteScope],
  );
  // Page discussions with new messages (server-counted, re-gated per read):
  // a badge on the rail door each sits behind, and a palette row per thread.
  const discussionUnread = useDiscussionUnread();
  const inbox = useSharedNotifications();
  const commands = useMemo(
    () => [
      ...rawCommands,
      ...discussionUnread.threads.map((t): Command => ({
        id: `discussion-unread:${t.channel}`,
        label: discussionCommandLabel(t),
        group: 'New messages',
        ...(t.lastMessagePreview ? { hint: t.lastMessagePreview } : {}),
        keywords: ['unread', 'new messages', 'discussion', t.channel],
        run: () => { navigate(t.href); },
      })),
    ].map(scopeCommand),
    [rawCommands, discussionUnread, navigate, scopeCommand],
  );
  const getDynamicCommands = useCallback(
    (query: string) => rawGetDynamicCommands(query).map(scopeCommand),
    [rawGetDynamicCommands, scopeCommand],
  );

  // The rail lists only what the role the viewer is acting as can open. A page another held role opens is
  // offered by the ⌘K palette and voice `open` with the switch as its hint (lib/pageAccess.ts), never here.
  const navItems = NAV_ITEMS.filter((item) => {
    if (item.needsMeetingAssistant && !meetingsAdvertised(session)) return false;
    if (item.tenant !== 'universal' && item.tenant !== 'admin' && !tenantEnabled(item.tenant)) return false;
    if (item.tenant === 'universal') return true;
    if (session?.role === 'admin') return item.tenant === session?.tenant;
    if (item.requireRoles && !(session && item.requireRoles.includes(session.role ?? ''))) return false;
    return item.tenant === session?.tenant;
  });

  // Platform surfaces (Build tooling, Operate, Identity) are org-tenant
  // scoped: a session parked on another tenant gets that tenant's nav,
  // not the org platform's — switching workspace brings it back.
  // Platform surfaces are orgiq-only. Within that, the gate is PER ITEM rather
  // than a second role list in front of the first.
  //
  // It used to be both: a broad `showPlatform` (hr-admin / org-leader / admin)
  // and then each item's `requireRoles`. Naming a role on an item therefore did
  // nothing unless that role was also in the outer list — which is how `sme`
  // stayed locked out of Computers after being added to its requireRoles. Two
  // gates for one question is a gate you will forget to open.
  //
  // An item with no `requireRoles` is unrestricted among the platform roles, so
  // it still needs the broad check; an item that names roles is authoritative.
  const onOrgiq = (session?.tenant ?? 'orgiq') === 'orgiq';
  const isPlatformRole =
    session?.role === 'hr-admin' || session?.role === 'org-leader' || session?.role === 'admin';

  const platformItems = onOrgiq
    ? PLATFORM_ITEMS.filter((item) => {
        if (!session) return false;
        // The cross-tenant admin role passes every role gate.
        if (session.role === 'admin') return true;
        if (!item.requireRoles) return isPlatformRole;
        return item.requireRoles.includes(session.role ?? '');
      })
    : [];

  // The one number worth interrupting for: work that is blocked on a human.
  // Findings and queued jobs are not counted — those are the system working,
  // not the system waiting.
  const needsYou =
    (work?.jobs['awaiting_review'] ?? 0) + (work?.proposals['pending'] ?? 0) + (runbookReviews?.count ?? 0);

  // Combine the tenant + platform items and order them by rail group
  // (Build → OrgIQ → Operate → System). Array.sort is stable, so items keep
  // their definition order within a group.
  const visibleItems = [...navItems, ...platformItems];
  const activities = navigationActivity({ tenant: session?.tenant ?? '', actorId: session?.sub ?? '',
    hasSocialGrant: !!session?.grants.social?.length, visiblePaths: visibleItems.map(item => item.path) }, inbox.notifications, discussionUnread);
  const subNavItems: SubNavItem[] = visibleItems
    .map((i) => ({
      path: i.path,
      label: i.label,
      ...(i.group ? { group: i.group } : {}),
      ...(activities[i.path] ? { activity: activities[i.path] } : {}),
      // The blocked-on-a-human count rides the Delivery door now that the
      // Work queue lives behind it rather than beside it.
      // Each door also counts the page discussions behind it with new messages.
      ...(() => { const count = railCount(i.path, i.path === '/iq/projects' ? needsYou : 0, discussionUnread); return count ? { count } : {}; })(),
    }))
    // Group order is the tenant's (shared with the palette, portalCommands.ts).
    .sort((a, b) => groupRank(session?.tenant ?? 'orgiq', a.group) - groupRank(session?.tenant ?? 'orgiq', b.group));

  const credsExpired = healthFailed(health?.awsCredentials);
  const dbDown = healthFailed(health?.datastore);
  const checkingHealth = healthPending(health?.awsCredentials) || healthPending(health?.datastore);
  const tenantLabel = TENANT_LABELS[session?.tenant ?? 'orgiq'];

  const shellRef = useRef<HTMLDivElement>(null);

  // The tenant marker ALSO goes on <html>, mirroring how `data-theme` is set
  // (lib/preferences.ts). It has to: custom properties inherit downward only,
  // and the shell <Stack> below is a grandchild of <body> — so
  // `body { background: var(--color-bg) }` resolves the token from :root and
  // can never see the tenant's value. The practical effect was that a tenant
  // could restyle anything INSIDE the app div (buttons, chips, the nav tint)
  // but structurally could not change the page ground, which is why every
  // tenant has so far read as orgiq wearing a different accent. Two files
  // already carry workarounds for the same root cause (ChatSessionPicker,
  // graphOverlay) — they read the token from the tenant element because the
  // ambient one is wrong there.
  const tenantAttr = session?.tenant ?? 'orgiq';
  useEffect(() => {
    document.documentElement.setAttribute('data-tenant', tenantAttr);
  }, [tenantAttr]);


  // The navigation drawer below md (the rails fold there): a word at tablet width, an icon on a phone.
  const navigationMenu = (
    <DropdownMenu
      trigger={phoneHeader ? <MenuIcon size={16} aria-hidden="true" /> : 'Navigation'}
      triggerLabel={`${tenantLabel} navigation`}
      triggerTitle={phoneHeader ? 'Navigation' : undefined}
      triggerClassName={phoneHeader ? 'md:hidden grid h-7 w-7 place-items-center border-0 p-0' : 'md:hidden text-xs'}
      className="max-h-[70vh] overflow-y-auto"
      sections={Array.from(new Set(subNavItems.map((item) => item.group))).map((group) => ({
        label: group,
        items: subNavItems.filter((item) => item.group === group).map((item) => ({
          label: item.label,
          active: pathname === item.path || pathname.startsWith(`${item.path}/`),
          onSelect: () => navigate(item.path),
        })),
      }))}
    />
  );

  return (
    <ConversationInputProvider>
    <ShellCallHost onDialogueChange={setHuddleDialogueOpen}>
    <TodayPlacementProvider>
    <EmbeddedSocialProvider>
    <CommandPaletteProvider commands={commands} getDynamicCommands={getDynamicCommands}>
      <Stack ref={shellRef} gap="none" data-tenant={tenantAttr} className="h-screen">
        {/* First in the tab order, visible only while focused: a keyboard
            user lands on the page content without walking the header, the
            rail and the nested rail first (WCAG 2.4.1, Bypass Blocks). */}
        <SkipLink targetId="main-content" />
        <AmbientVisitorTargets scope={shellRef} selector='[data-shell-nav] > div > aside:first-child nav > section:has(> button[aria-expanded="true"])' />
        <Inline as="header" justify="between" align="center" wrap={!phoneHeader} className={phoneHeader ? 'shell-header px-3 border-b border-border shrink-0' : 'shell-header px-4 border-b border-border shrink-0'} data-header-rows={phoneHeader ? 'one' : undefined}>
          <Inline gap={phoneHeader ? 'xs' : 'md'} align="center" wrap={false} className="min-w-0 flex-1">
            {phoneHeader && navigationMenu}
            <TenantSwitcher label={tenantLabel} healthy={health?.status === 'ok' && !credsExpired && !dbDown && !checkingHealth} />
            <TodayStripSlot placement="header" />
          </Inline>
            <Inline gap={phoneHeader ? 'xs' : 'md'} wrap={!phoneHeader} {...(phoneHeader ? { align: 'center' as const, className: 'shrink-0' } : {})}>
              {!phoneHeader && navigationMenu}
              <CommandPaletteHint {...(phoneHeader ? { variant: 'icon' as const } : {})} />
              {/* The user's own machine in the fleet — renders nothing until
                  a machine is paired, so most sessions never see it.
                  orgiq only, like DevboxQuickSwitch and ComputeDock below:
                  unguarded, it put an orgiq machine (and the initiative and
                  branch it was working on) in the assessment header, with an
                  "Open Computer Lab" action leading out of the tenant. The
                  server filters these nodes by OWNER, which is not the same
                  question as which workspace you are standing in. */}
              {/* What the fleet is running right now. Renders nothing when
                  nothing runs. Its poll is orgiq-only (`/api/bots` is
                  requireTenant('orgiq')), so in the assessment shell it
                  never fetches and never renders. */}
              <FleetIndicator compact={phoneHeader} />
              {/* Replies, mentions, DMs, missed calls, approvals — addressed
                  to this user, filtered to the tenants they hold a grant in
                  (docs/social-tenant-design.md §3). */}
              <ActivityBell />
              <MasqueradeMenu compact={phoneHeader} />
            </Inline>
        </Inline>
        <Stack gap="none" className="flex-1 min-h-0" data-shell-nav
          data-primary-rail={rails.primary} data-section-rail={rails.section} data-drill-depth={rails.depth}>
          <SubNavLayout
            title={tenantLabel}
            items={subNavItems}
            railWidth={200}
            collapsed={dialogueRail.folded}
            titleAction={(
              <IconButton
                size="sm"
                variant="ghost"
                aria-label={rails.primary === 'open' ? `Collapse ${tenantLabel} navigation` : `Expand ${tenantLabel} navigation`}
                aria-expanded={rails.primary === 'open'}
                icon={<ChevronIcon size={14} dir={rails.primary === 'open' ? 'left' : 'right'} />}
                onClick={rails.togglePrimary}
                data-testid="shell-rail-toggle"
              />
            )}
            storageKey="orgiq-shell"
            railLabel={`${tenantLabel} navigation`}
            renderNavItem={(item, children) => (
              <NavLink
                to={['/iq/projects', '/iq/designs', '/iq/library', '/iq/decisions'].includes(item.path) ? `${item.path}?nav=section` : item.path}
                // className, not the inline `style` the composite's own doc
                // comment used to force: ui-components 2.275.1 exports the
                // class-name equivalents of `activeNavItemStyle`, so the whole
                // app's primary rail paints from tokens through Tailwind like
                // every nested rail does. See docs/ui-components-queue.md.
                className={({ isActive }) => {
                  // Two door-widening rules: /iq/sprints still redirects into
                  // the sprints lens (keep Initiatives lit for that instant),
                  // and Bots/Changes live BEHIND the Automate door.
                  const active = isActive || (
                    item.path === '/assessment/workspace' && pathname.startsWith('/assessment/decks')
                  ) || (
                    item.path === '/iq/projects' && pathname.startsWith('/iq/sprints')
                  ) || (
                    item.path === '/iq/work' &&
                    (pathname.startsWith('/admin/bots') || pathname.startsWith('/admin/changes'))
                  ) || (
                    // The prompt-management family all lives behind Library.
                    item.path === '/iq/library' && (
                      pathname.startsWith('/iq/prompt-ops') ||
                      pathname.startsWith('/iq/prompts') ||
                      pathname.startsWith('/iq/history') ||
                      pathname.startsWith('/iq/diff') ||
                      pathname.startsWith('/iq/evaluations') ||
                      pathname.startsWith('/iq/canary')
                    )
                  );
                  // Type scale, row height and the current-item mark all come
                  // from the library's one rail scale (ui-components 2.397.0
                  // `railType`), the same constants the Initiatives explorer
                  // rail beside this one draws from — so the two rails can't
                  // drift apart again (they were 13px vs 15px).
                  //
                  // Only the tint is ours: the library fills the current item
                  // with primary at 8%, but the shell's PRIMARY rail is
                  // recorded as carrying the tenant's brand tint
                  // (docs/branding-journeys/*.md measure the active fill as
                  // --color-brand-soft; `bg-primary-soft` resolves to it per
                  // tenant). It must REPLACE the library's fill rather than
                  // sit beside it — two same-specificity utilities resolve by
                  // stylesheet order, not attribute order — and it replaces
                  // the exported token, not a spelled-out class, so a library
                  // change can't turn this into a silent no-op (it did once:
                  // 2.397.0 retired the `bg-surface-hover` this used to swap).
                  return active
                    ? activeNavItemClassName.replace(RAIL_CURRENT_FILL, 'bg-primary-soft')
                    : inactiveNavItemClassName;
                }}
              >
                {children}
              </NavLink>
            )}
          >
            <RailBandProvider band={band}>
            <Stack gap="none" className="h-full bg-bg">
              {/* Where you are, once you're 3+ levels deep — stacked rails say
                  what you can open, the trail says where you stand. */}
              <Breadcrumbs />
              {/* The huddle chat opens in the right split pane beside the page
                  (HuddleChat.tsx); with no pane open the page takes the width. */}
              <Stack gap="none" className="flex-1 min-h-0">
                <HuddleChatSplit>
                  <Stack gap="none" className="h-full min-h-0">
                    {/* The page column: it scrolls over its own dock, where a page's command
                        composer docks (ColumnDock) when no section layout draws a nearer one. */}
                    <DockedColumn bodyClassName="flex flex-col outline-none" bodyProps={{ id: 'main-content', tabIndex: -1 }}>
                      <Outlet />
                    </DockedColumn>
                    {/* In a breakout room: which room, its timer and Return to main (CallMeeting.tsx). */}
                    <MeetingRoomBanner />
                    {/* The call bar and tiles for a call no on-screen composer carries, docked under the page. */}
                    <CallBlock placement="block" />
                  </Stack>
                </HuddleChatSplit>
              </Stack>
            </Stack>
            </RailBandProvider>
          </SubNavLayout>
        </Stack>
        {/* One footer row (docs/design/initiative-huddle-shell-plan.md, "Global
            footer"): a nonshrinking sibling after the shell body, never an
            overlay; it also holds the call's single media sink. */}
        <SocialFooter />
        <CommandPalette
          {...(paletteScope === 'devbox' ? {} : { searchRecords: recordSearch, onOpenRecord: openRecord })}
          placeholder={
            paletteScope === 'devbox'
              ? DEVBOX_PALETTE_PLACEHOLDER
              : PALETTE_PLACEHOLDER[session?.tenant ?? 'orgiq'] ?? 'Jump to a page…'
          }
        />
        {/* The Computer Lab is an orgiq surface. Mounting its quick-switch and
            dock in every tenant's shell put orgiq journeys one click away from
            an assessment session — the tenants are separate products on a
            shared BFF, and a session scoped to one must not see the other's
            chrome. */}
        {session?.tenant === 'orgiq' && <DevboxQuickSwitch onScopeChange={setPaletteScope} />}
        <ToastHost />
        {session?.tenant === 'orgiq' && <ComputeDock />}
      </Stack>
    </CommandPaletteProvider>
    </EmbeddedSocialProvider>
    </TodayPlacementProvider>
    </ShellCallHost>
    </ConversationInputProvider>
  );
}
