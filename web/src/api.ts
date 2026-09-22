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
  confidenceThreshold: number | null;
  automationPaused: boolean | null;
  dryRun: boolean | null;
  systemPromptOverride: string | null;
  logRetentionDays: number | null;
  psaCapabilitiesProbedAt: number | null;
  lastPollStatus: string | null;
  lastPollError: string | null;
  lastPollFinishedAt: number | null;
  lastPollDurationMs: number | null;
  lastPollTicketCount: number | null;
  hasSuperopsApiKey: boolean;
  hasAiApiKey: boolean;
  createdAt: number | null;
}

export interface Client {
  id: string;
  tenantId: string;
  name: string;
  superopsCompanyId: string | null;
  automationEnabled: boolean;
  contextNotes: string | null;
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
  entities: string | null;
  reasoning: string | null;
  followUpQuestion: string | null;
  escalationReason: string | null;
  proposedPsaNote: string | null;
  rawAiResponse?: string | null;
  status: string | null;
  errorMessage: string | null;
  aiModel: string | null;
  aiLatencyMs: number | null;
  notePosted: boolean | null;
  noteError: string | null;
  noteAttempts?: number | null;
  reviewVerdict: ReviewVerdict | null;
  reviewCorrectClassification: string | null;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  createdAt: number | null;
  ticketUrl?: string | null;
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
  daily: Array<{ date: string; total: number; reviewed: number; correct: number }>;
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

export const getMe = () =>
  api.get<{ id: string; email: string; role: string | null; lastLoginAt: number | null }>('/auth/me');

export const changePassword = (currentPassword: string, newPassword: string) =>
  api.post<{ ok: boolean; note?: string }>('/auth/change-password', { currentPassword, newPassword });

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

export const pruneLogs = (id: string) =>
  api.post<{ ok: boolean; bodiesCleared: number; rowsDeleted: number; ledgerRowsDeleted: number }>(
    `/tenants/${id}/prune-logs`,
  );

export const getPsaClients = (id: string) =>
  api.get<{ available: boolean; companies: PsaCompany[]; reason?: string; error?: string }>(
    `/tenants/${id}/psa-clients`,
  );

// ─── Clients ──────────────────────────────────────────────────────────────────
export const getClients = (tenantId?: string) =>
  api.get<Client[]>('/clients', { params: tenantId ? { tenantId } : undefined });

export const createClient = (data: {
  tenantId: string;
  name: string;
  superopsCompanyId?: string;
  automationEnabled?: boolean;
  contextNotes?: string;
}) => api.post<Client>('/clients', data);

export const updateClient = (id: string, data: Partial<Client>) => api.patch<Client>(`/clients/${id}`, data);

export const deleteClient = (id: string) => api.delete<{ ok: boolean }>(`/clients/${id}`);

// ─── Actions ──────────────────────────────────────────────────────────────────
export interface ActionQuery {
  tenantId?: string;
  clientId?: string;
  classification?: string;
  sensitivity?: 'normal' | 'high';
  status?: 'classified' | 'ai_failed' | 'note_failed';
  review?: 'correct' | 'incorrect' | 'unreviewed';
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

export const getAction = (id: string) => api.get<ActionLog>(`/actions/${id}`);

export const getActionStats = (params: { tenantId?: string; clientId?: string; days?: number } = {}) =>
  api.get<QuickStats>('/actions/stats', { params: clean(params) });

export const getCalibration = (params: { tenantId?: string; clientId?: string; days?: number } = {}) =>
  api.get<CalibrationReport>('/actions/metrics', { params: clean(params) });

export const getClassifications = () => api.get<{ classifications: string[] }>('/actions/classifications');

export const reviewAction = (
  id: string,
  body: { verdict: ReviewVerdict | null; correctClassification?: string | null; note?: string | null },
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
