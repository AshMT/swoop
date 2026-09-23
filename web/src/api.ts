import type { Entities } from './lib/format';
import axios, { AxiosError } from 'axios';

const api = axios.create({ baseURL: '/api' });

export const TOKEN_KEY = 'swoop_token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing: the session simply does not persist across reloads */
  }
}

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    // A 401 means the token is gone or expired. Bounce to the login screen,
    // but never from the login request itself or we would loop.
    if (err.response?.status === 401 && !err.config?.url?.includes('/auth/login')) {
      setToken(null);
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login');
      }
    }
    return Promise.reject(err);
  },
);

/** Pulls the server's error message out of an Axios failure. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    if (data?.error) return data.error;
    if (err.code === 'ERR_NETWORK') return 'Cannot reach the Swoop server.';
    if (err.response?.status) return `Request failed with HTTP ${err.response.status}`;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export default api;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  superopsSubdomain: string;
  superopsRegion: string | null;
  aiBaseUrl: string | null;
  aiModel: string | null;
  lastPolledAt: number | null;
  pollIntervalSeconds: number | null;
  classifyConcurrency: number | null;
  confidenceThreshold: number | null;
  automationPaused: boolean | null;
  dryRun: boolean | null;
  systemPromptOverride: string | null;
  noteFormat: string | null;
  logRetentionDays: number | null;
  psaCapabilitiesProbedAt: number | null;
  lastPollStatus: string | null;
  lastPollError: string | null;
  lastPollFinishedAt: number | null;
  lastPollDurationMs: number | null;
  lastPollTicketCount: number | null;
  hasSuperopsApiKey: boolean;
  hasAiApiKey: boolean;
  hasCippClientSecret: boolean;
  cippEnabled: boolean | null;
  cippApiUrl: string | null;
  cippTenantId: string | null;
  cippClientId: string | null;
  kbLastSyncedAt?: number | null;
  createdAt: number | null;
}

export interface Client {
  id: string;
  tenantId: string;
  name: string;
  superopsCompanyId: string | null;
  automationEnabled: boolean;
  contextNotes: string | null;
  systemPromptOverride: string | null;
  emailDomains: string[];
  m365TenantId: string | null;
  m365DefaultDomain: string | null;
  vipEmails: string[];
  authorisedContacts: string[];
  createdAt: number | null;
  actionCount?: number;
  lastActionAt?: number | null;
}

export type ReviewVerdict = 'correct' | 'incorrect';

export interface ActionLog {
  id: string;
  tenantId: string | null;
  clientId: string | null;
  ticketId: string;
  ticketDisplayId: string | null;
  ticketSubject: string | null;
  ticketBody?: string | null;
  requesterEmail: string | null;
  classification: string | null;
  confidence: number | null;
  sensitivity: string | null;
  entities: Entities | string | null;
  reasoning: string | null;
  followUpQuestion: string | null;
  escalationReason: string | null;
  proposedPsaNote: string | null;
  rawAiResponse?: string | null;
  status: string | null;
  errorMessage: string | null;
  aiModel: string | null;
  promptFingerprint?: string | null;
  aiLatencyMs: number | null;
  notePosted: boolean | null;
  noteError: string | null;
  noteAttempts?: number | null;
  reviewVerdict: ReviewVerdict | null;
  reviewCorrectClassification: string | null;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reviewCorrectCategory?: string | null;
  reviewCorrectPriority?: string | null;
  createdAt: number | null;
  ticketUrl?: string | null;

  // Triage
  category?: string | null;
  subcategory?: string | null;
  impact?: string | null;
  urgency?: string | null;
  priority?: Priority | null;
  summary?: string | null;
  sentiment?: string | null;
  suggestedQueue?: string | null;
  signals?: TriageSignal[] | null;
  matchMethod?: string | null;
  requesterDomain?: string | null;
  crossTenant?: boolean | null;
  duplicateOfLogId?: string | null;
  clusterId?: string | null;
  approvalState?: ApprovalState | null;
  approvalsRequired?: number | null;
  approvalExpiresAt?: number | null;
  supersededBy?: string | null;
  executionState?: string | null;
}

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';
export type ApprovalState =
  | 'not_required'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'auto_approved'
  | 'expired'
  | 'superseded';

export interface TriageSignal {
  id: string;
  label: string;
  detail: string;
  severity: 'info' | 'warn' | 'critical';
}

export interface SimilarTicket {
  logId: string;
  ticketId: string;
  displayId: string | null;
  subject: string;
  clientId: string | null;
  category: string | null;
  classification: string | null;
  priority: string | null;
  createdAt: number | null;
  similarity: number;
  sameRequester: boolean;
  sharedTerms: string[];
}

export interface TenancyAssessment {
  clientId: string;
  clientName: string;
  matchMethod: string;
  domainsConfigured: boolean;
  requesterDomain: string | null;
  requesterClient: { id: string; name: string } | null;
  targetEmail: string | null;
  targetDomain: string | null;
  targetClient: { id: string; name: string } | null;
  m365: { tenantId: string | null; defaultDomain: string | null } | null;
  flags: string[];
  crossTenant: boolean;
}

export interface PlanStep {
  order: number;
  description: string;
  method: 'GET' | 'POST';
  endpoint: string;
  payload: unknown;
}

export interface ExecutionPlan {
  action: string;
  actionLabel: string;
  backend: string;
  tenant: string | null;
  target: string | null;
  steps: PlanStep[];
  prechecks: Array<{ description: string; status: 'pass' | 'fail' | 'warn' | 'unknown'; detail?: string }>;
  blockers: string[];
  identity?: { configured: boolean; requesterIsTarget: boolean; requesterAuthorised: boolean; blocker: string | null; note: string } | null;
  reversible: boolean;
  rollback: string | null;
  executable: false;
  note: string;
}

export interface UserEnrichment {
  tenant: string;
  upn: string;
  found: boolean;
  displayName: string | null;
  accountEnabled: boolean | null;
  userType: string | null;
  jobTitle: string | null;
  department: string | null;
  onPremisesSync: boolean;
  licences: string[];
  lastPasswordChange: string | null;
  createdAt: string | null;
  groups: string[] | null;
  mfa: { registered: boolean | null; methods: string[]; perUser: string | null; coveredByCA: string | null } | null;
  fetchedAt: number;
  error: string | null;
}

export interface Decision {
  id: string;
  actionLogId: string;
  userId: string | null;
  userEmail: string | null;
  decision: 'approved' | 'rejected';
  reason: string | null;
  comment: string | null;
  verificationMethod?: string | null;
  verificationNote?: string | null;
  createdAt: number | null;
}

export interface IncidentCluster {
  id: string;
  tenantId: string | null;
  clientId: string | null;
  label: string;
  category: string | null;
  terms: string[];
  ticketCount: number | null;
  clientCount: number | null;
  status: 'open' | 'acknowledged' | 'resolved';
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  acknowledgedBy: string | null;
  acknowledgedAt: number | null;
  tickets?: Array<{
    id: string;
    ticketId: string;
    ticketDisplayId: string | null;
    ticketSubject: string | null;
    clientId: string | null;
    requesterEmail: string | null;
    priority: string | null;
    createdAt: number | null;
  }>;
}

export interface ActionDetail extends ActionLog {
  ticketBody: string | null;
  firstResponse: string | null;
  nextSteps: string[] | null;
  similar: SimilarTicket[] | null;
  tenancy: TenancyAssessment | null;
  executionPlan: ExecutionPlan | null;
  enrichment: UserEnrichment | null;
  approvalReason: string | null;
  investigation: Investigation | null;
  kbRefs: KbRef[] | null;
  agentEnabled?: boolean;
  decisions: Decision[];
  cluster: IncidentCluster | null;
  history: Array<{
    id: string;
    classification: string | null;
    priority: string | null;
    category: string | null;
    approvalState: string | null;
    createdAt: number | null;
  }>;
}

export interface ToolRun {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  result: string;
  ms: number;
}

export interface Investigation {
  status: 'completed' | 'failed' | 'unavailable';
  model: string | null;
  startedAt: number;
  durationMs: number;
  steps: ToolRun[];
  findings: string[];
  diagnosis: string | null;
  recommendation: { action: string | null; targetUserEmail: string | null; groupName: string | null; licenceName: string | null } | null;
  ungrounded: string[];
  technicianSteps: string[];
  replyToRequester: string | null;
  missingInformation: string | null;
  confidence: number | null;
  error: string | null;
}

export interface KbRef {
  id: string;
  title: string;
  snippet: string;
  score: number;
  clientSpecific: boolean;
  source: string;
}

export interface Runbook {
  id: string;
  tenantId: string;
  clientId: string | null;
  title: string;
  body: string;
  tags: string[];
  source: 'swoop' | 'superops';
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface ExecutionStep {
  order: number;
  description: string;
  method: 'GET' | 'POST';
  endpoint: string;
  payload: unknown;
  status: 'ok' | 'failed' | 'skipped' | 'planned' | 'uncertain';
  result: string | null;
  durationMs: number | null;
}

export interface ExecutionRun {
  id: string;
  action: string;
  mode: 'dry_run' | 'live';
  status: 'running' | 'dry_run_ok' | 'succeeded' | 'noop' | 'failed' | 'blocked' | 'uncertain';
  startedBy: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  target: string | null;
  m365Tenant: string | null;
  steps: ExecutionStep[];
  verification: 'verified' | 'reported' | 'pending' | 'failed' | 'skipped' | null;
  verificationDetail: string | null;
  summary: string | null;
  hasSecret: boolean;
  secretExpiresAt: number | null;
  secretRevealedBy: string | null;
  secretRevealedAt: number | null;
  rollback: string | null;
  notePosted: boolean | null;
  replyPosted: boolean | null;
}

export interface ExecutionReadiness {
  mode: 'off' | 'dry_run' | 'live';
  canDryRun: boolean;
  canRunLive: boolean;
  reasons: string[];
  attestationRequired: boolean;
  attested: boolean;
  lastDryRunOk: boolean;
}

export interface AgentSettings {
  enabled: boolean;
  autoRun: 'actions' | 'all' | 'manual';
  model: string | null;
  maxSteps: number;
}

export interface ExecutionPolicy {
  mode: 'off' | 'dry_run' | 'live';
  actions: string[];
  clientIds: string[];
  requireDryRun: boolean;
  runOnApproval: boolean;
  postResultNote: boolean;
  replyToRequester: boolean;
}

export interface Vocabulary {
  actions: Array<{ id: string; label: string; description: string; sensitive: boolean }>;
  categories: Array<{ id: string; label: string; description: string; defaultQueue: string }>;
  priorities: Array<{ id: Priority; label: string }>;
  impacts: string[];
  urgencies: string[];
  rejectionReasons: Array<{ id: string; label: string }>;
  verificationMethods: Array<{ id: string; label: string }>;
  executableActions: string[];
  attestationActions: string[];
}

export interface QueueSummary {
  days: number;
  priorities: Record<'P1' | 'P2' | 'P3' | 'P4' | 'untriaged', number>;
  pendingApprovals: number;
  crossTenant: number;
  openIncidents: number;
}

export interface TriageSettings {
  businessHours: { timezone: string; days: number[]; start: string; end: string };
  queueRouting: Record<string, string>;
  afterHoursQueue: string;
  repeatRequesterThreshold: number;
  duplicateWindowHours: number;
  clusterWindowMinutes: number;
  clusterThreshold: number;
  useReviewedExamples: boolean;
}

export interface ApprovalPolicy {
  autoApprove: { enabled: boolean; minConfidence: number; actions: string[]; clientIds: string[] };
  dualApprovalForSensitive: boolean;
  expiryHours: number;
  postDecisionNotes: boolean;
}

export type Role = 'viewer' | 'reviewer' | 'approver' | 'admin';

export interface Me {
  id: string;
  email: string;
  role: Role | null;
  displayName: string | null;
  lastLoginAt: number | null;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  role: Role | null;
  disabled: boolean | null;
  createdAt: number | null;
  lastLoginAt: number | null;
  invitedBy: string | null;
}

export interface InviteRow {
  id: string;
  email: string;
  role: Role;
  createdBy: string | null;
  expiresAt: number;
  createdAt: number | null;
}

export interface AuditEntry {
  id: string;
  userId: string | null;
  userEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  tenantId: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: number | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface QuickStats {
  total: number;
  byClassification: Record<string, number>;
  highSensitivity: number;
  failures: number;
  awaitingReview: number;
  reviewed: number;
  agreement: number | null;
}

export interface ClassificationBreakdown {
  classification: string;
  total: number;
  reviewed: number;
  correct: number;
  incorrect: number;
  agreement: number | null;
  avgConfidence: number | null;
}

export interface CalibrationReport {
  totalClassified: number;
  totalFailed: number;
  reviewed: number;
  correct: number;
  incorrect: number;
  agreement: number | null;
  reviewCoverage: number | null;
  readiness: 'insufficient-data' | 'below-floor' | 'approaching-target' | 'at-target';
  minimumSampleSize: number;
  byClassification: ClassificationBreakdown[];
  confusion: Array<{ predicted: string; actual: string; count: number }>;
  highSensitivity: number;
  avgConfidence: number | null;
  avgConfidenceWhenCorrect: number | null;
  avgConfidenceWhenIncorrect: number | null;
  latency: { p50: number | null; p95: number | null; avg: number | null };
  noteDelivery: { posted: number; failed: number };
  daily: Array<{
    date: string;
    total: number;
    reviewed: number;
    correct: number;
    agreement: number | null;
  }>;
  promptVersions: Array<{
    fingerprint: string | null;
    total: number;
    reviewed: number;
    correct: number;
    agreement: number | null;
    model: string | null;
    firstSeenAt: number | null;
    lastSeenAt: number | null;
  }>;
  /** Absent from servers older than the triage release. */
  dimensions?: {
    category: DimensionScore;
    priority: DimensionScore & { tooHigh: number; tooLow: number };
  };
}

export interface DimensionScore {
  reviewed: number;
  correct: number;
  agreement: number | null;
  confusion: Array<{ predicted: string; actual: string; count: number }>;
}

export interface PsaCapabilities {
  version: number;
  probedAt: number;
  endpoint: string;
  listQuery: string | null;
  listResultField: string | null;
  ticketType: string | null;
  idField: string;
  displayIdField: string | null;
  subjectField: string | null;
  bodyField: string | null;
  bodySubField?: string | null;
  conversationQuery?: string | null;
  ticketFields?: string[];
  createdField: string | null;
  detailQuery: string | null;
  noteMutation: string | null;
  noteContentField: string | null;
  clientListQuery: string | null;
  sortClause: { attribute: string; order: string } | null;
  client: { shape: string; fieldName: string | null; idField: string | null; labelField: string | null };
  requester: { shape: string; fieldName: string | null; labelField: string | null };
  warnings: string[];
}

export interface SystemStatus {
  version: string;
  nodeEnv: string;
  encryptionEnabled: boolean;
  poller: { running: boolean; tenants: number; inFlight: string[] };
  tenants: Array<{
    id: string;
    name: string;
    automationPaused: boolean;
    dryRun: boolean;
    pollIntervalSeconds: number | null;
  classifyConcurrency: number | null;
    confidenceThreshold: number | null;
    lastPolledAt: number | null;
    lastPollStatus: string | null;
    lastPollError: string | null;
    lastPollFinishedAt: number | null;
    lastPollDurationMs: number | null;
    lastPollTicketCount: number | null;
    aiModel: string | null;
    capabilitiesProbedAt: number | null;
    capabilityWarnings: string[];
  }>;
  warnings: string[];
  healthy: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  endpoint?: string;
  error?: string;
  capabilities?: PsaCapabilities;
  bodyCheck?: { ticket: string; characters: number; preview: string } | { ticket: string | null; error: string };
}

export interface PollSummary {
  outcome: 'ok' | 'degraded' | 'error' | 'paused' | 'idle';
  error: string | null;
  fetched: number;
  classified: number;
  failed: number;
  skipped: Record<string, number>;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const login = (email: string, password: string) =>
  api.post<{ token: string; email: string }>('/auth/login', { email, password });

export const getMe = () => api.get<Me>('/auth/me');

export const changePassword = (currentPassword: string, newPassword: string) =>
  api.post<{ ok: boolean; note?: string; token?: string }>('/auth/change-password', { currentPassword, newPassword });

export const logoutEverywhere = () => api.post<{ ok: boolean }>('/auth/logout-everywhere');

export const getInvite = (token: string) =>
  api.get<{ email: string; role: Role; expiresAt: number }>(`/auth/invite/${encodeURIComponent(token)}`);

export const acceptInvite = (token: string, password: string, displayName?: string) =>
  api.post<{ token: string; email: string; role: Role }>('/auth/accept-invite', { token, password, displayName });

// ─── Setup ────────────────────────────────────────────────────────────────────
export interface SetupStatus {
  setupComplete: boolean;
  hasAdmin: boolean;
  hasTenant: boolean;
  hasClient: boolean;
  tenantId: string | null;
  tenantName: string | null;
}

export const getSetupStatus = () => api.get<SetupStatus>('/setup/status');

export const setupAdmin = (email: string, password: string) =>
  api.post<{ token: string; email: string }>('/setup/admin', { email, password });

export const testSuperOps = (subdomain: string, apiKey: string, region: string) =>
  api.post<ConnectionTestResult>('/setup/test-superops', { subdomain, apiKey, region });

export const setupTenant = (name: string, subdomain: string, apiKey: string, region: string) =>
  api.post<{ id: string; name: string; slug: string; updated: boolean }>('/setup/tenant', {
    name,
    subdomain,
    apiKey,
    region,
  });

export const testAi = (baseUrl: string, apiKey: string, model: string) =>
  api.post<{ ok: boolean; error?: string; reply?: string; latencyMs?: number }>('/setup/test-ai', {
    baseUrl,
    apiKey,
    model,
  });

export const setupAiConfig = (tenantId: string, baseUrl: string, apiKey: string, model: string) =>
  api.post<{ ok: boolean }>('/setup/ai-config', { tenantId, baseUrl, apiKey, model });

export const setupClient = (
  tenantId: string,
  name: string,
  superopsCompanyId?: string,
  automationEnabled?: boolean,
) => api.post<{ id: string; name: string }>('/setup/client', { tenantId, name, superopsCompanyId, automationEnabled });

// ─── Tenants ──────────────────────────────────────────────────────────────────
export const getTenants = () => api.get<Tenant[]>('/tenants');

export const updateTenant = (id: string, data: Partial<Record<string, unknown>>) =>
  api.patch<Tenant>(`/tenants/${id}`, data);

export const testTenantConnection = (id: string) =>
  api.post<ConnectionTestResult>(`/tenants/${id}/test-connection`);

export const getCapabilities = (id: string) =>
  api.get<{ probed: boolean; probedAt?: number; capabilities: PsaCapabilities | null }>(
    `/tenants/${id}/capabilities`,
  );

export const pollNow = (id: string) =>
  api.post<{ ok: boolean; summary?: PollSummary; error?: string | null }>(`/tenants/${id}/poll-now`);

export const getDefaultPrompt = (id: string) => api.get<{ prompt: string }>(`/tenants/${id}/default-prompt`);

export interface PsaCompany {
  id: string;
  name: string;
}

export interface LogStorage {
  rows: number;
  oldestAt: number | null;
  bodyBytes: number;
  totalBytes: number;
  logRetentionDays: number;
}

export const getLogStorage = (id: string) => api.get<LogStorage>(`/tenants/${id}/log-storage`);

export interface NotePreview {
  current: string;
  formats: Array<{ id: string; label: string; description: string; preview: string }>;
}

export const getNotePreview = (id: string) => api.get<NotePreview>(`/tenants/${id}/note-preview`);

export const pruneLogs = (id: string) =>
  api.post<{ ok: boolean; bodiesCleared: number; rowsDeleted: number; ledgerRowsDeleted: number }>(
    `/tenants/${id}/prune-logs`,
  );

export const getPsaClients = (id: string) =>
  api.get<{ available: boolean; companies: PsaCompany[]; reason?: string; error?: string }>(
    `/tenants/${id}/psa-clients`,
  );

// ─── Clients ──────────────────────────────────────────────────────────────────
export const getPolicies = (id: string) =>
  api.get<{
    triageSettings: TriageSettings;
    approvalPolicy: ApprovalPolicy;
    agentSettings: AgentSettings;
    executionPolicy: ExecutionPolicy;
    executionDisabledByInstall: boolean;
    executableActions: string[];
    categories: Vocabulary['categories'];
  }>(`/tenants/${id}/policies`);

export const syncKnowledgeBase = (id: string) =>
  api.post<{ ok: boolean; available: boolean; imported: number; removed: number; error?: string }>(`/tenants/${id}/kb-sync`);

export const testCipp = (id: string) =>
  api.post<{ ok: boolean; tenantCount?: number; tenants?: Array<{ domain: string | null; name: string | null }>; error?: string }>(
    `/tenants/${id}/test-cipp`,
  );

export const getClients = (tenantId?: string) =>
  api.get<Client[]>('/clients', { params: tenantId ? { tenantId } : undefined });

export const createClient = (data: {
  tenantId: string;
  name: string;
  superopsCompanyId?: string;
  automationEnabled?: boolean;
  contextNotes?: string;
  systemPromptOverride?: string;
  emailDomains?: string[];
  m365TenantId?: string | null;
  m365DefaultDomain?: string | null;
  vipEmails?: string[];
  authorisedContacts?: string[];
}) => api.post<Client>('/clients', data);

export const updateClient = (id: string, data: Partial<Client>) => api.patch<Client>(`/clients/${id}`, data);

export const getSuggestedDomains = (id: string) =>
  api.get<{ suggestions: Array<{ domain: string; tickets: number }> }>(`/clients/${id}/suggested-domains`);

export const deleteClient = (id: string) => api.delete<{ ok: boolean }>(`/clients/${id}`);

// ─── Actions ──────────────────────────────────────────────────────────────────
export interface ActionQuery {
  tenantId?: string;
  clientId?: string;
  classification?: string;
  sensitivity?: 'normal' | 'high';
  status?: 'classified' | 'ai_failed' | 'note_failed';
  review?: 'correct' | 'incorrect' | 'unreviewed';
  priority?: Priority;
  category?: string;
  queue?: string;
  approval?: ApprovalState;
  crossTenant?: 'true';
  clusterId?: string;
  latest?: 'true';
  sort?: 'newest' | 'priority';
  q?: string;
  days?: number;
  limit?: number;
  offset?: number;
}

/** Drops empty values so the query string stays readable and cacheable. */
function clean(params: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== '' && value !== null),
  );
}

export const getActions = (params: ActionQuery = {}) =>
  api.get<Paginated<ActionLog>>('/actions', { params: clean(params) });

export const getAction = (id: string) => api.get<ActionDetail>(`/actions/${id}`);

export const getQueueSummary = (params: { tenantId?: string; days?: number } = {}) =>
  api.get<QueueSummary>('/actions/queue-summary', { params: clean(params) });

export const getVocabulary = () => api.get<Vocabulary>('/actions/vocabulary');

export const approveAction = (
  id: string,
  body: { comment?: string; verificationMethod?: string | null; verificationNote?: string | null } = {},
) => api.post<{ ok: boolean; state: string; approvals: number; required: number }>(`/actions/${id}/approve`, body);

export const investigateAction = (id: string) => api.post<Investigation>(`/actions/${id}/investigate`);

export const getExecutions = (id: string) =>
  api.get<{ runs: ExecutionRun[]; readiness: ExecutionReadiness }>(`/actions/${id}/executions`);

export const executeAction = (id: string, mode: 'dry_run' | 'live') =>
  api.post<{ ok: boolean; executionId: string }>(`/actions/${id}/execute`, { mode });

export const revealExecutionSecret = (executionId: string) =>
  api.post<{ secret: string }>(`/actions/executions/${executionId}/reveal`);

export const resolveExecution = (executionId: string, outcome: 'succeeded' | 'failed', note?: string) =>
  api.post<{ ok: boolean }>(`/actions/executions/${executionId}/resolve`, { outcome, note });

// ─── Knowledge ────────────────────────────────────────────────────────────────
export const getRunbooks = (tenantId: string, clientId?: string) =>
  api.get<Runbook[]>('/knowledge', { params: clean({ tenantId, clientId }) });

export const searchRunbooks = (tenantId: string, q: string, scope: { clientId?: string; general?: boolean } = {}) =>
  api.get<KbRef[]>('/knowledge/search', {
    params: clean({ tenantId, q, clientId: scope.clientId, scope: scope.general ? 'general' : scope.clientId ? 'client' : 'all' }),
  });

export const createRunbook = (data: { tenantId: string; clientId: string | null; title: string; body: string; tags?: string[] }) =>
  api.post<{ id: string }>('/knowledge', data);

export const updateRunbook = (id: string, data: { clientId?: string | null; title?: string; body?: string; tags?: string[] }) =>
  api.patch<{ ok: boolean }>(`/knowledge/${id}`, data);

export const deleteRunbook = (id: string) => api.delete<{ ok: boolean }>(`/knowledge/${id}`);

export const rejectAction = (id: string, reason: string, comment?: string) =>
  api.post<{ ok: boolean; state: string }>(`/actions/${id}/reject`, { reason, comment });

// ─── Incidents ────────────────────────────────────────────────────────────────
export const getIncidents = (params: { tenantId?: string; status?: string; days?: number } = {}) =>
  api.get<IncidentCluster[]>('/incidents', { params: clean(params) });

export const setIncidentStatus = (id: string, status: 'open' | 'acknowledged' | 'resolved') =>
  api.post<{ ok: boolean }>(`/incidents/${id}/status`, { status });

// ─── People ───────────────────────────────────────────────────────────────────
export const getRoles = () => api.get<Array<{ id: Role; label: string; description: string }>>('/users/roles');

export const getUsers = () => api.get<{ users: UserRow[]; invites: InviteRow[] }>('/users');

export const inviteUser = (email: string, role: Role) =>
  api.post<{ id: string; email: string; role: Role; token: string; expiresAt: number; path: string }>(
    '/users/invites',
    { email, role },
  );

export const revokeInvite = (id: string) => api.delete<{ ok: boolean }>(`/users/invites/${id}`);

export const updateUser = (id: string, data: { role?: Role; disabled?: boolean; displayName?: string | null }) =>
  api.patch<{ ok: boolean }>(`/users/${id}`, data);

export const deleteUser = (id: string) => api.delete<{ ok: boolean }>(`/users/${id}`);

export const getAudit = (params: { limit?: number; before?: number; action?: string; targetId?: string } = {}) =>
  api.get<AuditEntry[]>('/users/audit', { params: clean(params) });

export const getActionStats = (params: { tenantId?: string; clientId?: string; days?: number } = {}) =>
  api.get<QuickStats>('/actions/stats', { params: clean(params) });

export const getCalibration = (
  params: { tenantId?: string; clientId?: string; days?: number; promptFingerprint?: string } = {},
) => api.get<CalibrationReport>('/actions/metrics', { params: clean(params) });

export const getClassifications = () => api.get<{ classifications: string[] }>('/actions/classifications');

export const reviewAction = (
  id: string,
  body: {
    verdict: ReviewVerdict | null;
    correctClassification?: string | null;
    correctCategory?: string | null;
    correctPriority?: Priority | null;
    note?: string | null;
  },
) => api.post<ActionLog>(`/actions/${id}/review`, body);

export const bulkReview = (ids: string[], verdict: ReviewVerdict | null) =>
  api.post<{ ok: boolean; updated: number }>('/actions/bulk-review', { ids, verdict });

export const reclassifyAction = (id: string, postNote = false) =>
  api.post<{ ok: boolean; actionLogId?: string; error?: string }>(`/actions/${id}/reclassify`, { postNote });

/**
 * The CSV endpoint needs the bearer token, which a plain link cannot send, so
 * fetch it and hand the browser a blob instead.
 */
export async function downloadCsv(params: ActionQuery = {}): Promise<void> {
  const response = await api.get('/actions/export.csv', {
    params: clean(params),
    responseType: 'blob',
  });
  const url = URL.createObjectURL(response.data as Blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `swoop-actions-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ─── System ───────────────────────────────────────────────────────────────────
export const getSystemStatus = () => api.get<SystemStatus>('/system/status');

/** Where Swoop reads the ticket text from, or null when it found nowhere. */
export function bodySource(caps: Pick<PsaCapabilities, 'bodyField' | 'bodySubField' | 'conversationQuery'> | null | undefined): string | null {
  if (!caps) return null;
  if (caps.bodyField) return caps.bodySubField ? `${caps.bodyField}.${caps.bodySubField}` : caps.bodyField;
  if (caps.conversationQuery) return `${caps.conversationQuery} (first message)`;
  return null;
}
