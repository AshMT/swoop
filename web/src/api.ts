import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('swoop_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('swoop_token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  },
);

export default api;

// ─── Auth ──────────────────────────────────────────────────────────────────────
export const login = (email: string, password: string) =>
  api.post<{ token: string; email: string }>('/auth/login', { email, password });

// ─── Setup ────────────────────────────────────────────────────────────────────
export const getSetupStatus = () =>
  api.get<{ setupComplete: boolean; hasAdmin: boolean; hasTenant: boolean }>('/setup/status');

export const setupAdmin = (email: string, password: string) =>
  api.post<{ token: string; email: string }>('/setup/admin', { email, password });

export const testSuperOps = (subdomain: string, apiKey: string, region: string = 'us') =>
  api.post<{ ok: boolean; error?: string; endpoint?: string }>('/setup/test-superops', { subdomain, apiKey, region });

export const setupTenant = (name: string, subdomain: string, apiKey: string, region: string = 'us') =>
  api.post<{ id: string; name: string; slug: string }>('/setup/tenant', { name, subdomain, apiKey, region });

export const testAi = (baseUrl: string, apiKey: string, model: string) =>
  api.post<{ ok: boolean }>('/setup/test-ai', { baseUrl, apiKey, model });

export const setupAiConfig = (tenantId: string, baseUrl: string, apiKey: string, model: string) =>
  api.post('/setup/ai-config', { tenantId, baseUrl, apiKey, model });

export const setupClient = (tenantId: string, name: string, superopsCompanyId?: string, automationEnabled?: boolean) =>
  api.post<{ id: string; name: string }>('/setup/client', { tenantId, name, superopsCompanyId, automationEnabled });

// ─── Tenants ──────────────────────────────────────────────────────────────────
export const getTenants = () => api.get<Tenant[]>('/tenants');

export const updateTenant = (id: string, data: {
  cippBaseUrl?: string | null;
  cippClientId?: string | null;
  cippClientSecret?: string | null;
  cippOauthTenantId?: string | null;
  cippApiScope?: string | null;
  aiBaseUrl?: string | null;
  aiApiKey?: string | null;
  aiModel?: string | null;
}) => api.patch(`/tenants/${id}`, data);

export const testCipp = (tenantId: string) =>
  api.post<{ ok: boolean; error?: string }>(`/tenants/${tenantId}/test-cipp`);

export const getIntegrationStatus = (tenantId: string) =>
  api.get<IntegrationStatus>(`/tenants/${tenantId}/status`);

// ─── Clients ──────────────────────────────────────────────────────────────────
export const getClients = (tenantId?: string) =>
  api.get<Client[]>('/clients', { params: tenantId ? { tenantId } : undefined });

export const createClient = (data: {
  tenantId: string;
  name: string;
  superopsCompanyId?: string;
  cippTenantId?: string;
  automationEnabled?: boolean;
}) => api.post<Client>('/clients', data);

export const updateClient = (id: string, data: Partial<Client>) =>
  api.patch<Client>(`/clients/${id}`, data);

export const deleteClient = (id: string) => api.delete(`/clients/${id}`);

// ─── Actions ──────────────────────────────────────────────────────────────────
export const getActions = (params?: { clientId?: string; tenantId?: string; classification?: string; status?: string; limit?: number }) =>
  api.get<ActionLog[]>('/actions', { params });

export const getPendingCount = (tenantId?: string) =>
  api.get<{ pending: number }>('/actions/pending-count', { params: tenantId ? { tenantId } : undefined });

export const getProcessing = (tenantId?: string) =>
  api.get<PipelineEntry[]>('/actions/processing', { params: tenantId ? { tenantId } : undefined });

export const getActionStats = (tenantId?: string) =>
  api.get<ActionStats>('/actions/stats', { params: tenantId ? { tenantId } : undefined });

export const approveAction = (id: string, verificationMethod?: string) =>
  api.post<ActionLog>(`/actions/${id}/approve`, verificationMethod ? { verificationMethod } : {});

export const rejectAction = (id: string, reason?: string) =>
  api.post<ActionLog>(`/actions/${id}/reject`, { reason });

export const getExecutionLog = (actionId: string) =>
  api.get<ExecutionLog>(`/actions/${actionId}/execution`);

// ─── Policies ─────────────────────────────────────────────────────────────────
export const getPolicies = (tenantId: string) =>
  api.get<ActionPolicy[]>('/policies', { params: { tenantId } });

export const updatePolicy = (
  actionType: string,
  data: { tenantId: string; permission?: PolicyPermission; requireVerification?: boolean },
) => api.patch<ActionPolicy>(`/policies/${actionType}`, data);

// ─── Types ────────────────────────────────────────────────────────────────────
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  superopsSubdomain: string;
  superopsRegion: string | null;
  aiBaseUrl: string | null;
  aiModel: string | null;
  cippBaseUrl: string | null;
  cippClientId: string | null;
  cippOauthTenantId: string | null;
  cippApiScope: string | null;
  autoConfidenceMin: number | null;
  lastPolledAt: number | null;
  createdAt: number | null;
}

export interface IntegrationCheck {
  configured: boolean;
  ok: boolean;
  error: string | null;
}

export interface IntegrationStatus {
  superops: IntegrationCheck;
  ai: IntegrationCheck;
  cipp: IntegrationCheck;
  checkedAt: number;
}

export type PipelineStage =
  | 'detected'
  | 'classifying'
  | 'posting_note'
  | 'deciding'
  | 'executing'
  | 'done';

export interface PipelineEntry {
  ticketId: string;
  tenantId: string;
  subject: string;
  clientName: string;
  stage: PipelineStage;
  classification: string | null;
  confidence: number | null;
  outcome: string | null;
  startedAt: number;
  updatedAt: number;
}

export type PolicyPermission = 'approval' | 'auto' | 'disabled';

export interface ActionPolicy {
  actionType: string;
  label: string;
  description: string;
  permission: PolicyPermission;
  requireVerification: boolean;
  isDefault: boolean;
}

export interface Client {
  id: string;
  tenantId: string;
  name: string;
  superopsCompanyId: string | null;
  cippTenantId: string | null;
  automationEnabled: boolean;
  createdAt: number | null;
}

export interface ActionLog {
  id: string;
  tenantId: string;
  clientId: string;
  ticketId: string;
  ticketSubject: string | null;
  ticketBody: string | null;
  requesterEmail: string | null;
  classification: string | null;
  confidence: number | null;
  sensitivity: string | null;
  entities: string | null;
  reasoning: string | null;
  followUpQuestion: string | null;
  proposedPsaNote: string | null;
  status: string | null;
  approvedBy: string | null;
  approvedAt: number | null;
  rejectionReason: string | null;
  verificationMethod: string | null;
  verifiedBy: string | null;
  verifiedAt: number | null;
  createdAt: number | null;
}

export interface ExecutionLog {
  id: string;
  actionLogId: string | null;
  executedAt: number | null;
  result: string | null;
  response: string | null;
  error: string | null;
}

export interface ActionStats {
  total: number;
  byClassification: Record<string, number>;
  byStatus: Record<string, number>;
  highSensitivity: number;
}
