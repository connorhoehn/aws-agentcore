import { lazy, Suspense } from 'react';
import { meetingsAdvertised } from './lib/meetingAssistantModel';
import { Routes, Route, Navigate, Outlet, useParams, useLocation } from 'react-router';
import { Layout } from './components/shell/Layout';
import { RequireRole, RequireTenant } from './lib/auth';
import { RouteErrorBoundary } from './components/shell/RouteErrorBoundary';
import { useSession } from './lib/auth';
import { ACCESS_ENABLED, ASSESSMENT_ENABLED, PIPELINES_ENABLED, SOCIAL_ENABLED, features, tenantEnabled } from './lib/features';
import { CHOOSER, resolveHome, tenantHome } from './lib/tenantHome';
import { computersRedirect } from './pages/computers/computersModel';
import type { Tenant } from './lib/tenants.generated';
import { OptionalGatewayProvider } from './components/OptionalGatewayProvider';
import { SharedNotificationsProvider } from './components/shell/SharedNotifications';
// Eager: a redirect has nothing to lazy-load and must not flash a spinner.
import LegacyVoiceLogRedirect from './pages/logging/LegacyVoiceLogRedirect';
import { ComputeHost } from './components/compute/ComputeHost';
import { LoadingState } from '@connorhoehn/ui-components/shared';

// Dev-only: the design reference sheet (docs/design/README.md). The ternary keeps
// the chunk out of production builds (cast: this repo has no vite-env.d.ts).
const ReferenceSheet = (import.meta as unknown as { env: { DEV: boolean } }).env.DEV ? lazy(() => import('./dev/ReferenceSheet')) : null;
// System › Logging (G37; the Voice log of G20 is its Voice source): the dev server with the voice navigator on, as the dock itself.
const LoggingPage = (import.meta as unknown as { env: { DEV: boolean } }).env.DEV && features.voiceLog ? lazy(() => import('./pages/logging/LoggingPage')) : null;
const AgentFlowPage = lazy(() => import('./pages/AgentFlowPage'));
const AgentDetailPage = lazy(() => import('./pages/iq/AgentDetailPage'));
const ScoresPage = lazy(() => import('./pages/ScoresPage'));
const ScoresCohortPage = lazy(() => import('./pages/ScoresCohortPage'));
const ScoresComparePage = lazy(() => import('./pages/ScoresComparePage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const ProjectDetailPage = lazy(() => import('./pages/ProjectDetailPage'));
const InitiativeDeckPage = lazy(() => import('./pages/projects/decks/InitiativeDeckPage'));
const DocumentRecordPage = lazy(() => import('./pages/iq/DocumentRecordPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const IqLayout = lazy(() => import('./pages/iq/IqLayout'));
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const AssessmentLayout = lazy(() => import('./pages/assessment/AssessmentLayout'));
const AssessmentDashboardPage = lazy(() => import('./pages/assessment/DashboardPage'));
const AssessmentSubmissionsPage = lazy(() => import('./pages/assessment/SubmissionsPage'));
const AssessmentFeedbackPage = lazy(() => import('./pages/assessment/FeedbackPage'));
const AssessmentReportsPage = lazy(() => import('./pages/assessment/ReportsPage'));
const AssessmentEnterprisePage = lazy(() => import('./pages/assessment/EnterprisePage'));
const AssessmentWorkspacePage = lazy(() => import('./pages/assessment/WorkspacePage'));
const AssessmentPromptsPage = lazy(() => import('./pages/assessment/PromptsPage'));
const AssessmentRulesPage = lazy(() => import('./pages/assessment/RulesPage'));
const AssessmentRunsPage = lazy(() => import('./pages/assessment/RunsPage'));
const AssessmentActivityPage = lazy(() => import('./pages/assessment/ActivityPage'));
const AssessmentDecksPage = lazy(() => import('./pages/assessment/decks/DecksListPage'));
const AssessmentDeckPage = lazy(() => import('./pages/assessment/decks/DeckPage'));
const AssessmentConfigurationPage = lazy(() => import('./pages/assessment/ConfigurationPage'));
const SocialLayout = lazy(() => import('./pages/social/SocialLayout'));
const SocialProfilePage = lazy(() => import('./pages/social/ProfilePage'));
const SocialChannelsPage = lazy(() => import('./pages/social/ChannelsPage'));
const SocialDmsPage = lazy(() => import('./pages/social/DmsPage'));
const SocialCallsPage = lazy(() => import('./pages/social/CallsPage'));
const CommunicationPlane = lazy(() => import('./pages/communication/CommunicationPlane'));
const SocialRoomsPage = lazy(() => import('./pages/social/RoomsPage'));
const SocialContactsPage = lazy(() => import('./pages/social/ContactsPage'));
const SocialTeamsPage = lazy(() => import('./pages/social/TeamsPage'));
const SocialRecordingsPage = lazy(() => import('./pages/social/RecordingsPage'));
const SocialConfigurationPage = lazy(() => import('./pages/social/ConfigurationPage'));
const SocialWorkGraphPage = lazy(() => import('./pages/social/WorkGraphPage'));
const SocialDeckPage = lazy(() => import('./pages/social/decks/SocialDeckPage'));
const PipelinesLayout = lazy(() => import('./pages/pipelines/PipelinesLayout'));
const PipelinesRunsPage = lazy(() => import('./pages/pipelines/RunsPage'));
const PipelinesRunDetailPage = lazy(() => import('./pages/pipelines/RunDetailPage'));
const PipelinesActivityPage = lazy(() => import('./pages/pipelines/ActivityPage'));
const PipelinesRunDeckPage = lazy(() => import('./pages/pipelines/decks/PipelineDeckPage'));
const PipelinesConfigurationPage = lazy(() => import('./pages/pipelines/ConfigurationPage'));
const IqRunsPage = lazy(() => import('./pages/iq/RunsPage'));
const IqRunPage = lazy(() => import('./pages/iq/RunPage'));
const IqActivityPage = lazy(() => import('./pages/iq/ActivityPage'));
const PipelinesArtifactsPage = lazy(() => import('./pages/pipelines/ArtifactsPage'));
const PipelinesDefinitionsPage = lazy(() => import('./pages/pipelines/DefinitionsPage'));
const PipelinesWorkflowsPage = lazy(() => import('./pages/pipelines/WorkflowsPage'));
const PipelinesApprovalsPage = lazy(() => import('./pages/pipelines/ApprovalsPage'));
const PipelinesQueuesPage = lazy(() => import('./pages/pipelines/QueuesPage'));
const PipelinesSourcesPage = lazy(() => import('./pages/pipelines/SourcesPage'));
const AccessLayout = lazy(() => import('./pages/access/AccessLayout'));
const AccessSettingsPage = lazy(() => import('./pages/access/SettingsPage'));
const AccessCatalogPage = lazy(() => import('./pages/access/CatalogPage'));
const AccessRequestsPage = lazy(() => import('./pages/access/RequestsPage'));
const AccessRequestNewPage = lazy(() => import('./pages/access/RequestNewPage'));
const AccessRequestRecordPage = lazy(() => import('./pages/access/RequestRecordPage'));
const AccessApprovalsPage = lazy(() => import('./pages/access/ApprovalsPage'));
const AccessPoliciesPage = lazy(() => import('./pages/access/PoliciesPage'));
const AccessReviewsPage = lazy(() => import('./pages/access/ReviewsPage'));
const AccessReviewRecordPage = lazy(() => import('./pages/access/ReviewRecordPage'));
const AccessAuditPage = lazy(() => import('./pages/access/AuditPage'));
const AccessConfigurationPage = lazy(() => import('./pages/access/ConfigurationPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const NoAccessPage = lazy(() => import('./pages/NoAccessPage'));
const OtherWorkspacePage = lazy(() => import('./pages/NoAccessPage').then((m) => ({ default: m.OtherWorkspacePage })));
const KnowledgeHomePage = lazy(() => import('./pages/knowledge/KnowledgeHomePage'));
const KnowledgeLayout = lazy(() => import('./pages/knowledge/KnowledgeLayout'));
const DropPage = lazy(() => import('./pages/DropPage'));
const SelectContextPage = lazy(() => import('./pages/SelectContextPage'));
const KBRegistryPage = lazy(() => import('./pages/admin/KBRegistryPage.js'));
const AgentProjectsPage = lazy(() => import('./pages/admin/AgentProjectsPage'));
const BotsPage = lazy(() => import('./pages/bots/BotsPage'));
const BudgetsPage = lazy(() => import('./pages/budgets/BudgetsPage'));
const BotDetailPage = lazy(() => import('./pages/bots/BotDetailPage'));
const ChangesPage = lazy(() => import('./pages/admin/ChangesPage'));
const ChangeReviewPage = lazy(() => import('./pages/admin/ChangeReviewPage'));
const KBDetailPage = lazy(() => import('./pages/admin/KBDetailPage.js'));
const SearchPage = lazy(() => import('./pages/search/SearchPage'));
const LegacySearchRedirect = lazy(() => import('./pages/search/LegacySearchRedirect'));
const CanaryPage = lazy(() => import('./pages/CanaryPage'));
const PromptStudioPage = lazy(() => import('./pages/capabilities/PromptsPage'));
const PromptHistoryPage = lazy(() => import('./pages/iq/PromptHistoryPage'));
const PromptOpsHomePage = lazy(() => import('./pages/iq/PromptOpsHomePage'));
const WorkHomePage = lazy(() => import('./pages/work/WorkHomePage'));
const WorkQueuePage = lazy(() => import('./pages/work/QueuePage'));
const DesignsPage = lazy(() => import('./pages/designs/DesignsPage'));
const MyWorkPage = lazy(() => import('./pages/iq/MyWorkPage'));
const MeetingsPage = lazy(() => import('./pages/meetings/MeetingsPage'));
const MeetingPage = lazy(() => import('./pages/meetings/MeetingPage'));
const DecisionsPage = lazy(() => import('./pages/decisions/DecisionsPage'));
const LibraryPage = lazy(() => import('./pages/library/LibraryPage'));
const RunbooksModule = lazy(() => import('./pages/runbooks/RunbooksModule'));
const RunbooksLibraryTab = lazy(() => import('./pages/runbooks/LibraryTab'));
const RunbooksProposalsTab = lazy(() => import('./pages/runbooks/ProposalsTab'));
const RunbooksObstaclesTab = lazy(() => import('./pages/runbooks/ObstaclesTab'));
const WorkFindingsPage = lazy(() => import('./pages/work/FindingsPage'));
const JobDetailPage = lazy(() => import('./pages/work/JobDetailPage'));
const GraphChangesPage = lazy(() => import('./pages/work/GraphChangesPage'));
const ComputersPage = lazy(() => import('./pages/computers/ComputersPage'));
const DiffPage = lazy(() => import('./pages/iq/DiffPage'));
const EvaluationsPage = lazy(() => import('./pages/iq/EvaluationsPage'));

// Ingest sub-pages
const IngestLayout = lazy(() => import('./pages/ingest/IngestLayout'));
const IngestCrawlPage = lazy(() => import('./pages/ingest/CrawlTargetsPage'));
const IngestHistoryPage = lazy(() => import('./pages/ingest/RunHistoryPage'));
const IngestSourcesPage = lazy(() => import('./pages/ingest/DataSourcesPage'));
const IngestStoragePage = lazy(() => import('./pages/ingest/StoragePage'));
const IngestSchedulesPage = lazy(() => import('./pages/ingest/SchedulesPage'));

// Capabilities sub-pages
const CapabilitiesHomePage = lazy(() => import('./pages/capabilities/CapabilitiesHomePage'));
const CapabilitiesGuardrailsPage = lazy(() => import('./pages/capabilities/GuardrailsPage'));
const CapabilitiesCodeInterpreterPage = lazy(() => import('./pages/capabilities/CodeInterpreterPage'));
const CapabilitiesBrowserPage = lazy(() => import('./pages/capabilities/BrowserPage'));

// Identity Management sub-pages (HRAdmin only)
const IdentityLayout = lazy(() => import('./pages/identity/IdentityLayout'));
const IdentityUsersPage = lazy(() => import('./pages/identity/UsersPage'));
const IdentityRolesPage = lazy(() => import('./pages/identity/RolesPage'));
const IdentityPoliciesPage = lazy(() => import('./pages/identity/PoliciesPage'));
const IdentitySchemaPage = lazy(() => import('./pages/identity/SchemaPage'));
const IdentityTestPage = lazy(() => import('./pages/identity/PolicyTestPage'));

// Observability sub-pages
const ObservabilityLayout = lazy(() => import('./pages/observability/ObservabilityLayout'));
const ObservabilitySummaryPage = lazy(() => import('./pages/observability/SummaryPage'));
const ObservabilityInvocationsPage = lazy(() => import('./pages/observability/InvocationsPage'));
const ObservabilityInvocationSearchPage = lazy(() => import('./pages/observability/InvocationSearchPage'));
const ObservabilityInvocationDetailPage = lazy(() => import('./pages/observability/InvocationDetailPage'));
const ObservabilityCapabilityEventsPage = lazy(() => import('./pages/observability/CapabilityEventsPage'));
const ObservabilityAgentMetricsPage = lazy(() => import('./pages/observability/AgentMetricsPage'));
const ObservabilitySessionsPage = lazy(() => import('./pages/observability/SessionsPage'));
const ObservabilityAuthzPage = lazy(() => import('./pages/observability/AuthzLogPage'));
const ObservabilityDriftPage = lazy(() => import('./pages/observability/DriftPage'));
const ObservabilityOnCallPage = lazy(() => import('./pages/observability/OnCallPage'));
const ObservabilityQualityPage = lazy(() => import('./pages/observability/QualityPage'));
const ObservabilityCostPage = lazy(() => import('./pages/observability/CostPage'));
const ObservabilityCalibrationPage = lazy(() => import('./pages/observability/CalibrationPage'));
const ObservabilityModelComparePage = lazy(() => import('./pages/observability/ModelComparePage'));
const ObservabilityMemoryPage = lazy(() => import('./pages/observability/MemoryPage'));
const ObservabilityGuardrailRulesPage = lazy(() => import('./pages/observability/GuardrailRulesPage'));
const ObservabilityTrafficPage = lazy(() => import('./pages/observability/TrafficPage'));
const ObservabilityToolCallsPage = lazy(() => import('./pages/observability/ToolCallsPage'));
const ObservabilityApprovalsPage = lazy(() => import('./pages/observability/ApprovalQueuePage'));
const ObservabilityHarnessLayout = lazy(() => import('./pages/observability/harness/HarnessLayout'));
const ObservabilityHarnessHomePage = lazy(() => import('./pages/observability/harness/HarnessHomePage'));
const ObservabilityHarnessRunDetailPage = lazy(() => import('./pages/observability/harness/RunDetailPage'));
const ObservabilityHarnessCompareRunsPage = lazy(() => import('./pages/observability/harness/CompareRunsPage'));

// ---------------------------------------------------------------------------
// An absent gateway is an offline deployment, not a localhost socket endpoint.
// ---------------------------------------------------------------------------

const GATEWAY_URL =
  (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_GATEWAY_URL;

// ---------------------------------------------------------------------------

function Loading() {
  return <LoadingState label="Loading page…" />;
}

function Page({ element }: { element: React.ReactNode }) {
  // Keyed on the location so navigating away from a failed page clears
  // the boundary; the shell around the page never unmounts.
  const location = useLocation();
  return (
    <RouteErrorBoundary resetKey={location.pathname + location.search}>
      <Suspense fallback={<Loading />}>{element}</Suspense>
    </RouteErrorBoundary>
  );
}

function KbDetailRedirect() {
  const { id } = useParams();
  return <Navigate to={`/admin/knowledge/registry/${id ?? ''}`} replace />;
}

function LegacyDecisionRedirect() {
  const { id } = useParams();
  return <Navigate to={`/iq/decisions/${id ?? ''}`} replace />;
}

/** The two old computer pages, and their query strings, land on the one Computers page. */
function ComputersRedirect() {
  const { search } = useLocation();
  return <Navigate to={computersRedirect(search)} replace />;
}

function LegacyWorkspaceRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={`${CHOOSER}${search}${hash}`} replace />;
}

/**
 * Send this identity home — the one resolution in lib/tenantHome.ts, used
 * both for `/` and for every guard that refuses entry to a route tree.
 *
 * A guard's fallback must never point back inside the tree it guards. That is
 * exactly how /iq/projects became a blank page for an assessor: the guard
 * denied, the fallback re-entered, the guard denied again, and the URL never
 * moved. So if the home we resolved is the page we are already standing on,
 * this identity has no home to send them to — render not-found and say so,
 * rather than bouncing forever behind an empty content column.
 */
function HomeRedirect() {
  const { session, isLoading } = useSession();
  const { pathname } = useLocation();
  if (isLoading) return <Loading />;
  // A route this role may not open (a RequireRole/RequireTenant fallback) keeps the person in the
  // workspace they are already in — the tenant's front door, not the workspace chooser
  // (docs/work-journeys-goal.md, refusals). The root and a signed-out visit still resolve as before.
  const inTenant = !!session?.tenant && pathname !== '/' && tenantEnabled(session.tenant) && tenantHome(session.tenant) !== CHOOSER;
  const home = inTenant ? tenantHome(session!.tenant) : resolveHome(session);
  if (home === pathname) return <Page element={<NotFoundPage />} />;
  return <Navigate to={home} replace />;
}

/**
 * A URL another workspace owns (every tenant tree's RequireTenant fallback). It used to redirect
 * silently to the viewer's own front door; now the URL stays and the page says whose it is, offering
 * "Switch workspace" only when the session holds a grant there (pages/NoAccessPage.tsx,
 * lib/pageAccess.ts `otherWorkspaceRefusal`). A signed-out visit still goes home to sign in.
 */
function OtherWorkspace({ tenant }: { tenant: Tenant }) {
  const { session, isLoading } = useSession();
  if (isLoading) return <Loading />;
  if (!session) return <HomeRedirect />;
  return <Page element={<OtherWorkspacePage tenant={tenant} />} />;
}

/**
 * A route gated to `roles` (every tenant's gated pages; lane D extended it from orgiq and platform to
 * Pipelines Configuration and Access Approvals/Configuration/Audit). A role that cannot open it gets the "no access" page
 * in place, with the URL kept — what the page is, which role opens it, and the next step that exists
 * (lib/pageAccess.ts) — instead of the old silent redirect to the tenant's front door, which left a member on
 * an empty "My initiatives" view with no word about why (UX walk, 9 November 2026).
 */
function Gate({ roles, children }: { roles: readonly string[]; children: React.ReactNode }) {
  return <RequireRole roles={roles} fallback={<Page element={<NoAccessPage roles={roles} />} />}>{children}</RequireRole>;
}

/** Meetings exist only while the server advertises the meeting assistant; with it off the routes are the ordinary not-found. */
export function MeetingAssistantGate({ children }: { children: React.ReactNode }) {
  const { session, isLoading } = useSession();
  if (isLoading) return <Loading />;
  return meetingsAdvertised(session) ? <>{children}</> : <Page element={<NotFoundPage />} />;
}

export function App() {
  return (
    <OptionalGatewayProvider url={GATEWAY_URL}>
    <SharedNotificationsProvider>
    {/* One fleet for the whole app. Above the router because a shell must
        survive navigation, and because the Computers page, the ⌘K palette, the
        ⌘I switcher and Codebases all have to agree about which computers
        exist — the localStorage mirror this replaces let them disagree. */}
    <ComputeHost>
    <Routes>
      {/* ── Backwards-compat redirects (outside Layout so they catch bare paths) ── */}
      <Route path="agents" element={<Navigate to="/iq/agents" replace />} />
      <Route path="search" element={<Page element={<LegacySearchRedirect />} />} />
      <Route path="invoke" element={<Page element={<LegacySearchRedirect />} />} />
      <Route path="scores" element={<Navigate to="/iq/scores" replace />} />
      <Route path="scores/cohorts" element={<Navigate to="/iq/scores/cohorts" replace />} />
      <Route path="scores/compare" element={<Navigate to="/iq/scores/compare" replace />} />
      <Route path="decisions" element={<Navigate to="/iq/decisions" replace />} />
      <Route path="decisions/:id" element={<LegacyDecisionRedirect />} />
      <Route path="projects" element={<Navigate to="/iq/projects" replace />} />
      <Route path="projects/:id" element={<Navigate to="/iq/projects" replace />} />
      <Route path="explore" element={<Page element={<LegacySearchRedirect />} />} />
      <Route path="graph" element={<Page element={<LegacySearchRedirect />} />} />
      <Route path="code-interpreter" element={<Navigate to="/admin/capabilities/code-interpreter" replace />} />
      <Route path="knowledge-base" element={<Navigate to="/admin/knowledge" replace />} />
      <Route path="observability/*" element={<Navigate to="/admin/observability" replace />} />
      <Route path="ingest/*" element={<Navigate to="/admin/ingest" replace />} />
      <Route path="capabilities/*" element={<Navigate to="/admin/capabilities" replace />} />
      <Route path="identity/*" element={<Navigate to="/admin/identity" replace />} />

      {/* Share-link drop page — deliberately outside Layout. The person
          opening it has no account here, so showing them nav, a tenant
          switcher and a masquerade control would be both confusing and a
          small information leak about the org. */}
      <Route path="drop/:token" element={<Page element={<DropPage />} />} />
      {ReferenceSheet && <Route path="dev/reference-sheet" element={<Page element={<ReferenceSheet />} />} />}

      {/* Workspace chooser — outside Layout: it's the pre-app "select account +
          role" step, shown once after login for multi-context identities. */}
      <Route path="workspaces" element={<Page element={<SelectContextPage />} />} />
      <Route path="select" element={<LegacyWorkspaceRedirect />} />

      <Route element={<Layout />}>
        <Route index element={<HomeRedirect />} />
        <Route path="settings" element={<Page element={<SettingsPage />} />} />

        {/* ── /assessment/* — the second tenant, ported from
             agentic-assessment-accelerator. Feature-flagged ON by default
             (ASSESSMENT_ENABLED); set VITE_ENABLE_ASSESSMENT=false to park
             the route tree. See docs/assessment-tenant.md. ── */}
        {ASSESSMENT_ENABLED ? (
          <Route
            path="assessment"
            element={(
              <RequireTenant tenant="assessment" fallback={<OtherWorkspace tenant="assessment" />}>
                <Page element={<AssessmentLayout />} />
              </RequireTenant>
            )}
          >
            <Route index element={<Navigate to="teams" replace />} />
            <Route path="teams" element={<Page element={<AssessmentDashboardPage />} />} />
            <Route path="teams/:teamId" element={<Page element={<AssessmentDashboardPage />} />} />
            <Route path="submissions" element={<Page element={<AssessmentSubmissionsPage />} />} />
            {/* A submission opens as a page beside its list rail (record + revision history). */}
            <Route path="submissions/:submissionId" element={<Page element={<AssessmentSubmissionsPage />} />} />
            <Route path="decks" element={<Page element={<AssessmentDecksPage />} />} />
            <Route path="decks/:deckId" element={<Page element={<AssessmentDeckPage />} />} />
            <Route path="feedback" element={<Page element={<AssessmentFeedbackPage />} />} />
            <Route path="feedback/:taskId" element={<Page element={<AssessmentFeedbackPage />} />} />
            <Route path="reports" element={<Page element={<AssessmentReportsPage />} />} />
            <Route path="enterprise" element={<Page element={<AssessmentEnterprisePage />} />} />
            <Route path="workspace" element={<Page element={<AssessmentWorkspacePage />} />} />
            <Route path="prompts" element={<Page element={<AssessmentPromptsPage />} />} />
            <Route path="rules" element={<Page element={<AssessmentRulesPage />} />} />
            <Route path="runs" element={<Page element={<AssessmentRunsPage />} />} />
            <Route path="runs/:runId" element={<Page element={<AssessmentRunsPage />} />} />
            <Route path="activity" element={<Page element={<AssessmentActivityPage />} />} />
            {/* Communication: the Social plane embedded here (docs/social-tenant-design.md §4.6). Every assessment role opens it;
                Social reads are gated on the caller's Social grant at the BFF, and the Calls shelf (GET /api/calls/tenant) on ViewAssessment.
                The former Calls page lands on its Calls destination. Sub-routes mirror /social/* (one workspace, two mounts). */}
            <Route path="communication">
              <Route index element={<Page element={<CommunicationPlane route="channels" />} />} />
              <Route path="channels" element={<Page element={<CommunicationPlane route="channels" />} />} />
              <Route path="channels/:slug" element={<Page element={<CommunicationPlane route="channels" />} />} />
              <Route path="dms" element={<Page element={<CommunicationPlane route="dms" />} />} />
              <Route path="dms/:lobby" element={<Page element={<CommunicationPlane route="dms" />} />} />
              <Route path="teams" element={<Page element={<CommunicationPlane route="teams" />} />} />
              <Route path="rooms" element={<Page element={<CommunicationPlane route="rooms" />} />} />
              <Route path="calls" element={<Page element={<CommunicationPlane route="calls" />} />} />
              <Route path="recordings" element={<Page element={<CommunicationPlane route="recordings" />} />} />
            </Route>
            <Route path="calls" element={<Navigate to="/assessment/communication/calls" replace />} />
            <Route path="configuration" element={<Page element={<AssessmentConfigurationPage />} />} />
          </Route>
        ) : (
          <Route path="assessment/*" element={<Navigate to="/" replace />} />
        )}

        {/* ── /social/* — the third tenant (docs/social-tenant-design.md §4).
             Flag ON by default (SOCIAL_ENABLED). ── */}
        {SOCIAL_ENABLED ? (
          <Route
            path="social"
            element={(
              <RequireTenant tenant="social" fallback={<OtherWorkspace tenant="social" />}>
                <Page element={<SocialLayout />} />
              </RequireTenant>
            )}
          >
            <Route index element={<Navigate to="channels" replace />} />
            <Route path="channels" element={<Page element={<SocialChannelsPage />} />} />
            <Route path="channels/:slug" element={<Page element={<SocialChannelsPage />} />} />
            <Route path="dms" element={<Page element={<SocialDmsPage />} />} />
            <Route path="dms/:lobby" element={<Page element={<SocialDmsPage />} />} />
            <Route path="calls" element={<Page element={<SocialCallsPage />} />} />
            <Route path="rooms" element={<Page element={<SocialRoomsPage />} />} />
            <Route path="contacts" element={<Page element={<SocialContactsPage />} />} />
            <Route path="contacts/:userId" element={<Page element={<SocialContactsPage />} />} />
            <Route path="teams" element={<Page element={<SocialTeamsPage />} />} />
            <Route path="profile" element={<Page element={<SocialProfilePage />} />} />
            <Route path="recordings" element={<Page element={<SocialRecordingsPage />} />} />
            {/* The work graph: open to every social role (ViewSocial), like /api/social/work-graph. */}
            <Route path="work-graph" element={<Page element={<SocialWorkGraphPage />} />} />
            <Route path="configuration" element={<Page element={<SocialConfigurationPage />} />} />
            <Route path="decks/:deckId" element={<Page element={<SocialDeckPage />} />} />
            {/* Social settings was a registration stub (UX walk D): presence and do-not-disturb live on Profile, so the old URL lands there. */}
            <Route path="settings" element={<Navigate to="/social/profile" replace />} />
          </Route>
        ) : (
          <Route path="social/*" element={<Navigate to="/" replace />} />
        )}

        {/* ── /pipelines/* — the fourth tenant (docs/social-tenant-design.md
             §5). Flag ON by default (PIPELINES_ENABLED). Runs, run detail and
             Artifacts read the run projection (lane P0); Definitions,
             Runbooks, Approvals and the three Sources lists read the
             definition registry (lane P2); Configuration is pipeline-admin's. ── */}
        {PIPELINES_ENABLED ? (
          <Route
            path="pipelines"
            element={(
              <RequireTenant tenant="pipelines" fallback={<OtherWorkspace tenant="pipelines" />}>
                <Page element={<PipelinesLayout />} />
              </RequireTenant>
            )}
          >
            <Route index element={<Navigate to="runs" replace />} />
            <Route path="definitions" element={<Page element={<PipelinesDefinitionsPage />} />} />
            <Route path="definitions/:definitionId" element={<Page element={<PipelinesDefinitionsPage />} />} />
            <Route path="queues" element={<Page element={<PipelinesQueuesPage />} />} />
            <Route path="workflows" element={<Page element={<PipelinesWorkflowsPage />} />} />
            {/* Renamed from Runbooks (lane E7): the old address lands on Workflows. */}
            <Route path="runbooks" element={<Navigate to="/pipelines/workflows" replace />} />
            <Route path="runs" element={<Page element={<PipelinesRunsPage />} />} />
            <Route path="runs/:id" element={<Page element={<PipelinesRunDetailPage />} />} />
            {/* The activity graph: open to every pipelines role (ViewPipelines), like /api/pipelines/work-graph. */}
            <Route path="activity" element={<Page element={<PipelinesActivityPage />} />} />
            {/* Communication: the Social plane embedded here; Social reads gated on the Social grant, the Calls shelf on ViewPipelines. */}
            <Route path="communication">
              <Route index element={<Page element={<CommunicationPlane route="channels" />} />} />
              <Route path="channels" element={<Page element={<CommunicationPlane route="channels" />} />} />
              <Route path="channels/:slug" element={<Page element={<CommunicationPlane route="channels" />} />} />
              <Route path="dms" element={<Page element={<CommunicationPlane route="dms" />} />} />
              <Route path="dms/:lobby" element={<Page element={<CommunicationPlane route="dms" />} />} />
              <Route path="teams" element={<Page element={<CommunicationPlane route="teams" />} />} />
              <Route path="rooms" element={<Page element={<CommunicationPlane route="rooms" />} />} />
              <Route path="calls" element={<Page element={<CommunicationPlane route="calls" />} />} />
              <Route path="recordings" element={<Page element={<CommunicationPlane route="recordings" />} />} />
            </Route>
            <Route path="calls" element={<Navigate to="/pipelines/communication/calls" replace />} />
            <Route path="decks/:deckId" element={<Page element={<PipelinesRunDeckPage />} />} />
            <Route path="approvals" element={<Page element={<PipelinesApprovalsPage />} />} />
            <Route path="approvals/:approvalId" element={<Page element={<PipelinesApprovalsPage />} />} />
            <Route path="artifacts" element={<Page element={<PipelinesArtifactsPage />} />} />
            <Route path="agents" element={<Page element={<PipelinesSourcesPage source="agents" />} />} />
            <Route path="bots" element={<Page element={<PipelinesSourcesPage source="bots" />} />} />
            <Route path="commands" element={<Page element={<PipelinesSourcesPage source="commands" />} />} />
            {/* pipeline-admin only (separation of duties): author and operator
                never see Configuration — rail, palette and route agree. */}
            <Route path="configuration" element={
              <Gate roles={['pipeline-admin']}>
                <Page element={<PipelinesConfigurationPage />} />
              </Gate>
            } />
            {/* Pipeline settings was a registration stub with no preferences behind it (UX walk D): the old URL lands on the shared Settings page. */}
            <Route path="settings" element={<Navigate to="/settings" replace />} />
            {/* System › Logging in this tenant (G37b): the voice sessions and the pipeline runs it can read; dev server with the voice navigator on. */}
            {LoggingPage && <Route path="logging/*" element={<Page element={<LoggingPage />} />} />}
          </Route>
        ) : (
          <Route path="pipelines/*" element={<Navigate to="/" replace />} />
        )}

        {/* ── /access/* — the fifth tenant (docs/access-tenant-design.md).
             Flag ON by default (ACCESS_ENABLED). Every list page is a
             collection on the shared command composer from registration day
             (decision A9); Approvals is DecideAccess's (approver,
             access-admin) and Configuration access-admin's — rail, palette
             and route agree. Settings is the registered placeholder. ── */}
        {ACCESS_ENABLED ? (
          <Route
            path="access"
            element={(
              <RequireTenant tenant="access" fallback={<OtherWorkspace tenant="access" />}>
                <Page element={<AccessLayout />} />
              </RequireTenant>
            )}
          >
            <Route index element={<Navigate to="requests" replace />} />
            <Route path="catalog" element={<Page element={<AccessCatalogPage />} />} />
            <Route path="requests" element={<Page element={<AccessRequestsPage />} />} />
            <Route path="requests/new" element={<Page element={<AccessRequestNewPage />} />} />
            <Route path="requests/:id" element={<Page element={<AccessRequestRecordPage />} />} />
            <Route path="approvals" element={
              <Gate roles={['approver', 'access-admin']}>
                <Page element={<AccessApprovalsPage />} />
              </Gate>
            } />
            <Route path="policies" element={<Page element={<AccessPoliciesPage />} />} />
            <Route path="policies/:id" element={<Page element={<AccessPoliciesPage />} />} />
            <Route path="reviews" element={<Page element={<AccessReviewsPage />} />} />
            <Route path="reviews/:id" element={<Page element={<AccessReviewRecordPage />} />} />
            <Route path="audit" element={<Page element={<AccessAuditPage />} />} />
            <Route path="configuration" element={
              <Gate roles={['access-admin']}>
                <Page element={<AccessConfigurationPage />} />
              </Gate>
            } />
            <Route path="settings" element={<Page element={<AccessSettingsPage />} />} />
          </Route>
        ) : (
          <Route path="access/*" element={<Navigate to="/" replace />} />
        )}

        {/* ── /iq/* — OrgIQ tenant pages. Guarded like the other two trees:
             an assessor who types /iq/projects gets the other-workspace page
             (OtherWorkspace above), not an orgiq page that dies with the
             server's 403. ── */}
        <Route
          path="iq"
          element={(
            <RequireTenant tenant="orgiq" fallback={<OtherWorkspace tenant="orgiq" />}>
              <Page element={<IqLayout />} />
            </RequireTenant>
          )}
        >
          {/* The front door is the org's work (TENANT_HOME.orgiq), not the Automate inbox:
              a peer's first screen is the initiatives, not an agent queue. */}
          <Route index element={<Navigate to="projects" replace />} />
          {/* Architecture is a platform surface — nav shows it to platform
              roles only, so the route matches (it was URL-open to anyone). */}
          <Route path="agents" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Page element={<AgentFlowPage />} />
            </Gate>
          } />
          {/* One agent in depth. Architecture answers "what is the fleet";
              this answers "what is this one doing". */}
          <Route path="agents/:agentId" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Page element={<AgentDetailPage />} />
            </Gate>
          } />
          {/* Runs (Operate, lane E): this workspace's runs through the orgiq
              façade /api/runs — gated like it, the bots read gate
              (org-leader, hr-admin, program-owner + ManageBots: sme). */}
          <Route path="runs" element={
            <Gate roles={['hr-admin', 'sme', 'program-owner', 'org-leader']}>
              <Page element={<IqRunsPage />} />
            </Gate>
          } />
          <Route path="runs/:id" element={
            <Gate roles={['hr-admin', 'sme', 'program-owner', 'org-leader']}>
              <Page element={<IqRunPage />} />
            </Gate>
          } />
          <Route path="search" element={<Page element={<SearchPage />} />} />
          <Route path="documents/:documentId" element={<Page element={<DocumentRecordPage />} />} />
          {/* Activity/work graph, full page (docs/activity-graph-migration.md):
              reached from the initiative overview's pop-out, not the rail —
              like the reference's standalone page. Every orgiq role, as the API. */}
          <Route path="activity" element={<Page element={<IqActivityPage />} />} />
          {/* Communication (Org): the Social plane embedded in orgiq — every orgiq role opens it; Social reads are gated on the
              caller's Social grant at the BFF, the Calls shelf on GET /api/calls/tenant. The former Calls page lands on its Calls destination. Sub-routes mirror /social/* (one workspace, two mounts). */}
          <Route path="communication">
            <Route index element={<Page element={<CommunicationPlane route="channels" />} />} />
            <Route path="channels" element={<Page element={<CommunicationPlane route="channels" />} />} />
            <Route path="channels/:slug" element={<Page element={<CommunicationPlane route="channels" />} />} />
            <Route path="dms" element={<Page element={<CommunicationPlane route="dms" />} />} />
            <Route path="dms/:lobby" element={<Page element={<CommunicationPlane route="dms" />} />} />
            <Route path="teams" element={<Page element={<CommunicationPlane route="teams" />} />} />
            <Route path="rooms" element={<Page element={<CommunicationPlane route="rooms" />} />} />
            <Route path="calls" element={<Page element={<CommunicationPlane route="calls" />} />} />
            <Route path="recordings" element={<Page element={<CommunicationPlane route="recordings" />} />} />
          </Route>
          <Route path="calls" element={<Navigate to="/iq/communication/calls" replace />} />
          <Route path="invoke" element={<Page element={<LegacySearchRedirect />} />} />
          {/* Find Help folded into Ask — the chat is the org search. */}
          <Route path="help" element={<Page element={<LegacySearchRedirect />} />} />
          {/* Scores is leadership-only in the rail and the palette; the routes
              were open, so /scores → /iq/scores walked any role into a raw
              API 403. Same guard as Architecture and Prompt Studio. */}
          <Route path="scores" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Page element={<ScoresPage />} />
            </Gate>
          } />
          <Route path="scores/cohorts" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Page element={<ScoresCohortPage />} />
            </Gate>
          } />
          <Route path="scores/compare" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Page element={<ScoresComparePage />} />
            </Gate>
          } />
          <Route path="my-work" element={<Page element={<MyWorkPage />} />} />
          {/* Meetings: what the meeting assistant left behind, readable only by the people who were in the call (the server decides). */}
          <Route path="meetings" element={<MeetingAssistantGate><Page element={<MeetingsPage />} /></MeetingAssistantGate>} />
          <Route path="meetings/:callId" element={<MeetingAssistantGate><Page element={<MeetingPage />} /></MeetingAssistantGate>} />
          <Route path="decisions" element={<Page element={<DecisionsPage />} />} />
          <Route path="decisions/:id" element={<Page element={<DecisionsPage />} />} />
          <Route path="projects" element={<Page element={<ProjectsPage />} />} />
          <Route path="projects/:id" element={<Page element={<ProjectDetailPage />} />} />
          {/* System › Logging: one source's records as a list rail (voice, agents, pipelines, jobs), one opened beside it;
              the Voice log's old addresses redirect to the same record. */}
          {LoggingPage && <Route path="logging/*" element={<Page element={<LoggingPage />} />} />}
          {LoggingPage && <Route path="voice-log" element={<LegacyVoiceLogRedirect />} />}
          {LoggingPage && <Route path="voice-log/:sessionId" element={<LegacyVoiceLogRedirect />} />}
          {/* Initiative status deck (agentic-flows slice 6): reached from the
              initiative page, not the rail. The server gates every read. */}
          <Route path="decks/:deckId" element={<Page element={<InitiativeDeckPage />} />} />
          {/* Sprints merged into Initiatives as a lens — one program surface,
              two zooms. The old URL keeps working. */}
          <Route path="sprints" element={<Navigate to="/iq/projects?lens=sprints" replace />} />
          <Route path="explore" element={<Page element={<LegacySearchRedirect />} />} />
          {/* The demo page duplicated /admin/capabilities/code-interpreter
              (same execute endpoint) and had no inbound link anywhere. */}
          <Route path="code-interpreter" element={<Navigate to="/admin/capabilities/code-interpreter" replace />} />
          <Route path="canary" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Page element={<CanaryPage />} />
            </Gate>
          } />
          <Route path="prompt-ops" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Page element={<PromptOpsHomePage />} />
            </Gate>
          } />
          {/* Design reviews — the ADR threads that guide initiative designs.
              Read-open; answering and sign-off are gated by the API. */}
          {/* The asset library — prompts, system prompts, evaluators. Read
              open to the tenant; authoring and deploy stay gated. */}
          <Route path="library" element={<Page element={<LibraryPage />} />} />
          {/* A per-asset URL: the page opens its drawer from the param. */}
          <Route path="library/:assetId" element={<Page element={<LibraryPage />} />} />
          {/* Runbooks: the fleet's procedural
              memory. One module frame, three destinations — Library (a runbook
              opens as a page: /iq/runbooks/:id) and Proposals (/iq/runbooks/proposals/:pid
              is the review page) and Recurring obstacles (/iq/runbooks/obstacles,
              the Runs read gate); a run's frozen brief is on the run's page. */}
          <Route path="runbooks" element={<Page element={<RunbooksModule />} />}>
            <Route index element={<Page element={<RunbooksLibraryTab />} />} />
            <Route path="obstacles" element={
              <Gate roles={['hr-admin', 'sme', 'program-owner', 'org-leader']}>
                <Page element={<RunbooksObstaclesTab />} />
              </Gate>
            } />
            <Route path="proposals" element={<Page element={<RunbooksProposalsTab />} />} />
            <Route path="proposals/:pid" element={<Page element={<RunbooksProposalsTab />} />} />
            <Route path=":id" element={<Page element={<RunbooksLibraryTab />} />} />
          </Route>
          {/* Computers: paired machines and lab machines in one list (learning loop, lane E5). The two
              old pages redirect here; /admin/devbox is the other one (below). */}
          <Route path="computers" element={<Page element={<ComputersPage />} />} />
          <Route path="local-compute" element={<ComputersRedirect />} />
          <Route path="designs" element={<Page element={<DesignsPage />} />} />
          <Route path="designs/:id" element={<Page element={<DesignsPage />} />} />
          <Route path="work" element={<Page element={<WorkHomePage />} />} />
          <Route path="work/queue" element={<Page element={<WorkQueuePage />} />} />
          <Route path="work/findings" element={<Page element={<WorkFindingsPage />} />} />
          <Route path="work/changes" element={<Page element={<GraphChangesPage />} />} />
          <Route path="work/:jobId" element={<Page element={<JobDetailPage />} />} />
          {/* Prompt Studio / History / Diff / Evaluations are platform
              surfaces (the palette lists them for org-leader + hr-admin
              only), but the routes were open — the member audit walked
              straight into /iq/prompts and the Library linked there. Same
              guard the Architecture routes carry. */}
          <Route path="prompts" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Page element={<PromptStudioPage />} />
            </Gate>
          } />
          <Route path="history" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Page element={<PromptHistoryPage />} />
            </Gate>
          } />
          <Route path="diff" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Page element={<DiffPage />} />
            </Gate>
          } />
          <Route path="evaluations" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Page element={<EvaluationsPage />} />
            </Gate>
          } />
        </Route>

        {/* ── /admin/* — Admin / operations pages ── */}
        {/* Platform/admin surfaces belong to the org tenant's product; the
            cross-tenant admin role passes RequireTenant regardless. */}
        <Route
          path="admin"
          element={(
            <RequireTenant tenant="orgiq" fallback={<OtherWorkspace tenant="orgiq" />}>
              <Page element={<AdminLayout />} />
            </RequireTenant>
          )}
        >
          <Route index element={<Navigate to="observability" replace />} />

          {/* Knowledge — one destination for "where the agents' knowledge comes
              from". The registry list and the ingest summary were two front
              doors to the same subject, neither of which said whether any of it
              was working; both now land here. The stage pages below stay as
              drill-ins, reached from the pipeline rather than from the nav. */}
          {/* Guarded to match the nav + backend: reading the registry is
              org-leader/hr-admin visibility. Without this the route rendered for
              any role and then showed a raw 403 from the hr-admin-only API. */}
          <Route path="knowledge" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Page element={<KnowledgeLayout />} />
            </Gate>
          }>
            <Route index element={<Page element={<KnowledgeHomePage />} />} />
            <Route path="registry" element={<Page element={<KBRegistryPage />} />} />
            {/* Detail lives under the Knowledge layout so it keeps the rail,
                and "back" can return to the registry list it came from. */}
            <Route path="registry/:id" element={<Page element={<KBDetailPage />} />} />
          </Route>
          <Route path="knowledge-bases" element={<Navigate to="/admin/knowledge/registry" replace />} />
          {/* Old detail URL — preserved for bookmarks and stale links. */}
          <Route path="knowledge-bases/:id" element={<KbDetailRedirect />} />
          <Route path="knowledge-base" element={<Navigate to="/admin/knowledge" replace />} />
          {/* Repositories agents work on — distinct from /iq/projects, which
              is the org graph's initiatives. A repo may deliver one of those;
              the two are joined, not merged. */}
          {/* These three are hr-admin action surfaces (link/run codebases, approve
              & deliver changes, drive devboxes) — their APIs require ManageDevbox,
              so the route is guarded to match, keeping the page out of a role that
              would only hit 403s. */}
          <Route path="projects" element={
            <Gate roles={['hr-admin']}>
              <Page element={<AgentProjectsPage />} />
            </Gate>
          } />
          {/* Budgets — the program-manager's ledger: allocations vs. agent
              spend per initiative. Reads are platform-wide visibility
              (org-leader + hr-admin, like observability); writes are gated
              per-affordance on ManageBudgets inside the page. */}
          <Route path="budgets" element={
            <Gate roles={['org-leader', 'hr-admin', 'program-owner']}>
              <Page element={<BudgetsPage />} />
            </Gate>
          } />
          {/* Bots — durable, mission-configured agents. Open to every role
              that holds ManageBots in Cedar (sme, program-owner, leaders):
              setting up template bots / loop crons for mundane work is their
              job, and the API gates the writes. */}
          <Route path="bots" element={
            <Gate roles={['hr-admin', 'sme', 'program-owner', 'org-leader']}>
              <Page element={<BotsPage />} />
            </Gate>
          } />
          <Route path="bots/:id" element={
            <Gate roles={['hr-admin', 'sme', 'program-owner', 'org-leader']}>
              <Page element={<BotDetailPage />} />
            </Gate>
          } />
          {/* The governance queue for code agents wrote — review, approve, deliver. */}
          <Route path="changes" element={
            <Gate roles={['hr-admin', 'program-owner']}>
              <Page element={<ChangesPage />} />
            </Gate>
          } />
          {/* One change, reviewed properly: the diff with findings pinned to
              lines, authorship, gates, and the decision. */}
          <Route path="changes/:id" element={
            <Gate roles={['hr-admin', 'program-owner']}>
              <Page element={<ChangeReviewPage />} />
            </Gate>
          } />
          {/* The Computer Lab is one page with Local compute now: /iq/computers (lane E5). Old links
              (`?box=` from a work item's chip, `?machine=` from a voice link) keep working. */}
          <Route path="devbox" element={<ComputersRedirect />} />

          <Route path="ingest" element={
            <Gate roles={['hr-admin']}>
              <Page element={<IngestLayout />} />
            </Gate>
          }>
            {/* The old summary duplicated the Knowledge home, minus the part
                that mattered — whether the registry and the account agree. */}
            <Route index element={<Navigate to="/admin/knowledge" replace />} />
            <Route path="summary" element={<Navigate to="/admin/knowledge" replace />} />
            <Route path="crawl" element={<Page element={<IngestCrawlPage />} />} />
            <Route path="crawl/:targetId" element={<Page element={<IngestCrawlPage />} />} />
            <Route path="history" element={<Page element={<IngestHistoryPage />} />} />
            <Route path="history/:crawlId" element={<Page element={<IngestHistoryPage />} />} />
            <Route path="sources" element={<Page element={<IngestSourcesPage />} />} />
            <Route path="storage" element={<Page element={<IngestStoragePage />} />} />
            <Route path="schedules" element={<Page element={<IngestSchedulesPage />} />} />
          </Route>

          <Route path="observability" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Page element={<ObservabilityLayout />} />
            </Gate>
          }>
            <Route index element={<Navigate to="summary" replace />} />
            <Route path="oncall" element={<Page element={<ObservabilityOnCallPage />} />} />
            <Route path="summary" element={<Page element={<ObservabilitySummaryPage />} />} />
            <Route path="invocations" element={<Page element={<ObservabilityInvocationsPage />} />} />
            <Route path="invocations/search" element={<Page element={<ObservabilityInvocationSearchPage />} />} />
            <Route path="invocations/:invocationId" element={<Page element={<ObservabilityInvocationDetailPage />} />} />
            <Route path="capability-events" element={<Page element={<ObservabilityCapabilityEventsPage />} />} />
            <Route path="agents" element={<Page element={<ObservabilityAgentMetricsPage />} />} />
            <Route path="sessions" element={<Page element={<ObservabilitySessionsPage />} />} />
            <Route path="authz" element={<Page element={<ObservabilityAuthzPage />} />} />
            <Route path="drift" element={<Page element={<ObservabilityDriftPage />} />} />
            <Route path="quality" element={<Page element={<ObservabilityQualityPage />} />} />
            <Route path="cost" element={<Page element={<ObservabilityCostPage />} />} />
            <Route path="calibration" element={<Page element={<ObservabilityCalibrationPage />} />} />
            <Route path="model-compare" element={<Page element={<ObservabilityModelComparePage />} />} />
            <Route path="memory" element={<Page element={<ObservabilityMemoryPage />} />} />
            <Route path="guardrail-rules" element={<Page element={<ObservabilityGuardrailRulesPage />} />} />
            <Route path="traffic" element={<Page element={<ObservabilityTrafficPage />} />} />
            <Route path="tools" element={<Page element={<ObservabilityToolCallsPage />} />} />
            <Route path="approvals" element={<Page element={<ObservabilityApprovalsPage />} />} />
            <Route path="harness" element={<Page element={<ObservabilityHarnessLayout />} />}>
              <Route index element={<Page element={<ObservabilityHarnessHomePage />} />} />
              <Route path="runs/:runId" element={<Page element={<ObservabilityHarnessRunDetailPage />} />} />
              <Route path="compare/:runIdA/:runIdB" element={<Page element={<ObservabilityHarnessCompareRunsPage />} />} />
            </Route>
          </Route>

          {/* Capabilities is one page now, not a menu of AWS service names.
              The overview says what each capability is for and what in this
              app depends on it; the pages below are the diagnostics behind
              that, reached from the cards rather than from a rail. */}
          <Route path="capabilities" element={
            <Gate roles={['org-leader', 'hr-admin']}>
              <Outlet />
            </Gate>
          }>
            <Route index element={<Page element={<CapabilitiesHomePage />} />} />
            {/* The old landing tab duplicated the overview. */}
            <Route path="summary" element={<Navigate to="/admin/capabilities" replace />} />
            {/* This rendered the very same component as /iq/prompts — the
                same 2,000-line page mounted at two routes under two lazy
                names. One prompt library, one place to edit it. */}
            <Route path="prompts" element={<Navigate to="/iq/prompts" replace />} />
            <Route path="guardrails" element={<Page element={<CapabilitiesGuardrailsPage />} />} />
            <Route path="code-interpreter" element={<Page element={<CapabilitiesCodeInterpreterPage />} />} />
            <Route path="browser" element={<Page element={<CapabilitiesBrowserPage />} />} />
            {/* Rendered the same /api/sessions table as Observability →
                Sessions; one page owns that job now. */}
            <Route path="memory" element={<Navigate to="/admin/observability/sessions" replace />} />
          </Route>

          <Route path="identity" element={
            <Gate roles={['hr-admin']}>
              <Page element={<IdentityLayout />} />
            </Gate>
          }>
            <Route index element={<Navigate to="roles" replace />} />
            <Route path="users" element={<Page element={<IdentityUsersPage />} />} />
            <Route path="users/:userId" element={<Page element={<IdentityUsersPage />} />} />
            <Route path="roles" element={<Page element={<IdentityRolesPage />} />} />
            <Route path="policies" element={<Page element={<IdentityPoliciesPage />} />} />
            <Route path="schema" element={<Page element={<IdentitySchemaPage />} />} />
            <Route path="test" element={<Page element={<IdentityTestPage />} />} />
          </Route>
        </Route>

        {/* Catch-all: an unmatched path used to render a blank document. */}
        <Route path="*" element={<Page element={<NotFoundPage />} />} />
      </Route>
    </Routes>
    </ComputeHost>
    </SharedNotificationsProvider>
    </OptionalGatewayProvider>
  );
}
