import './setup-env';
import { describe, expect, it } from 'vitest';
import { decideApproval, DEFAULT_APPROVAL_POLICY, readApprovalPolicy } from '../src/services/approvals/policy';
import { buildExecutionPlan } from '../src/services/approvals/plan';
import { roleAtLeast } from '../src/domain/roles';
import type { TenancyAssessment } from '../src/services/triage/tenancy';

const input = {
  classification: 'password_reset',
  confidence: 0.97,
  sensitivity: 'normal' as const,
  clientId: 'c1',
  hasRiskSignals: false,
  crossTenant: false,
  planBlocked: false,
  now: 1_000_000,
};

describe('approval policy', () => {
  it('needs nothing for a non-action', () => {
    expect(decideApproval({ ...input, classification: 'ESCALATE' }, DEFAULT_APPROVAL_POLICY).state).toBe('not_required');
  });

  it('needs one person by default, with an expiry', () => {
    const d = decideApproval(input, DEFAULT_APPROVAL_POLICY);
    expect(d).toMatchObject({ state: 'pending', required: 1, expiresAt: 1_000_000 + 72 * 3600 });
  });

  it('needs two people for a sensitive action', () => {
    expect(decideApproval({ ...input, classification: 'mfa_reset' }, DEFAULT_APPROVAL_POLICY).required).toBe(2);
    expect(decideApproval({ ...input, sensitivity: 'high' }, DEFAULT_APPROVAL_POLICY).required).toBe(2);
  });

  it('auto-approves only a clean, confident, allowlisted action', () => {
    const policy = readApprovalPolicy(JSON.stringify({ autoApprove: { enabled: true } }));
    expect(decideApproval(input, policy).state).toBe('auto_approved');
    for (const blocker of [
      { confidence: 0.9 },
      { hasRiskSignals: true },
      { crossTenant: true },
      { planBlocked: true },
      { sensitivity: 'high' as const },
      { classification: 'group_add' },
      { classification: 'account_disable' },
    ]) {
      expect(decideApproval({ ...input, ...blocker }, policy).state).toBe('pending');
    }
  });

  it('restricts auto-approval to listed clients', () => {
    const policy = readApprovalPolicy(JSON.stringify({ autoApprove: { enabled: true, clientIds: ['c2'] } }));
    expect(decideApproval(input, policy).state).toBe('pending');
  });
});

describe('execution plan', () => {
  const tenancy = {
    clientId: 'c1',
    clientName: 'Acme',
    matchMethod: 'company_id',
    domainsConfigured: true,
    requesterDomain: 'acme.com',
    requesterClient: { id: 'c1', name: 'Acme' },
    targetEmail: 'sam@acme.com',
    targetDomain: 'acme.com',
    targetClient: { id: 'c1', name: 'Acme' },
    m365: { tenantId: null, defaultDomain: 'acme.onmicrosoft.com' },
    flags: [],
    crossTenant: false,
  } satisfies TenancyAssessment;
  const entities = { target_user_email: 'sam@acme.com', target_user_display_name: 'Sam', group_name: 'Finance', license_sku: null };

  it('builds real CIPP calls for a password reset', () => {
    const plan = buildExecutionPlan({ classification: 'password_reset', entities, tenancy, enrichment: null })!;
    expect(plan.executable).toBe(false);
    expect(plan.blockers).toEqual([]);
    expect(plan.steps.map((s) => s.endpoint)).toEqual(['/api/ListUsers', '/api/ExecResetPass']);
    expect(plan.steps[1].payload).toMatchObject({ tenantFilter: 'acme.onmicrosoft.com', ID: 'sam@acme.com', MustChange: true });
  });

  it('uses EditGroup, not the non-existent ExecAddMember', () => {
    const plan = buildExecutionPlan({ classification: 'group_add', entities, tenancy, enrichment: null })!;
    expect(plan.steps.map((s) => s.endpoint)).toContain('/api/EditGroup');
    expect(JSON.stringify(plan)).not.toContain('ExecAddMember');
  });

  it('re-enables through ExecDisableUser with Enable true', () => {
    const plan = buildExecutionPlan({ classification: 'account_enable', entities, tenancy, enrichment: null })!;
    expect(plan.steps[1]).toMatchObject({ endpoint: '/api/ExecDisableUser', payload: { Enable: true } });
  });

  it('sends mailbox rights in the object shape CIPP expects', () => {
    const plan = buildExecutionPlan({ classification: 'mailbox_permission', entities, tenancy, enrichment: null })!;
    expect(plan.steps[1].payload).toMatchObject({ AddFullAccess: [{ value: 'sam@acme.com' }] });
  });

  it('lists blockers instead of guessing', () => {
    const plan = buildExecutionPlan({
      classification: 'license_assign',
      entities: { ...entities, target_user_email: null },
      tenancy: { ...tenancy, m365: null, crossTenant: true },
      enrichment: null,
    })!;
    expect(plan.blockers.length).toBe(4);
  });

  it('fails a precheck for disabling an on-premises synced account, and warns for a reset', () => {
    const synced = {
      tenant: 'acme.onmicrosoft.com', upn: 'sam@acme.com', found: true, displayName: 'Sam', accountEnabled: true,
      userType: 'Member', jobTitle: null, department: null, onPremisesSync: true, licences: [], lastPasswordChange: null,
      createdAt: null, groups: [], mfa: null, fetchedAt: 0, error: null,
    };
    const reset = buildExecutionPlan({ classification: 'password_reset', entities, tenancy, enrichment: synced })!;
    expect(reset.prechecks.find((c) => c.description === 'Cloud-managed account')?.status).toBe('warn');
    const plan = buildExecutionPlan({
      classification: 'account_disable',
      entities,
      tenancy,
      enrichment: {
        tenant: 'acme.onmicrosoft.com', upn: 'sam@acme.com', found: true, displayName: 'Sam', accountEnabled: true,
        userType: 'Member', jobTitle: null, department: null, onPremisesSync: true, licences: [], lastPasswordChange: null,
        createdAt: null, groups: [], mfa: null, fetchedAt: 0, error: null,
      },
    })!;
    expect(plan.prechecks.find((c) => c.description === 'Cloud-managed account')?.status).toBe('fail');
  });
});

describe('roles', () => {
  it('orders roles and fails closed on unknown values', () => {
    expect(roleAtLeast('admin', 'approver')).toBe(true);
    expect(roleAtLeast('reviewer', 'approver')).toBe(false);
    expect(roleAtLeast('superuser', 'viewer')).toBe(false);
    expect(roleAtLeast(null, 'viewer')).toBe(false);
  });
});
