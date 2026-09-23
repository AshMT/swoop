import './setup-env';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { baseState, createFakeCipp, type FakeState } from './helpers/fake-cipp';

/**
 * The executor against a stateful fake CIPP. These are the tests that decide
 * whether Swoop can be trusted to change a client's tenant.
 */

type Executor = typeof import('../src/services/execution/executor');
let ex: Executor;
let state: FakeState;
let seq = 0;
const admin = { userId: 'admin-1', email: 'approver@msp.test', role: 'admin', displayName: null };

beforeAll(async () => {
  const { initializeDatabase, db } = await import('../src/db');
  const { tenants, clients } = await import('../src/db/schema');
  const { encrypt } = await import('../src/services/crypto');
  initializeDatabase();
  ex = await import('../src/services/execution/executor');
  ex.setVerifyDelaysForTesting([1, 1]);
  await db.insert(tenants).values({
    id: 't1',
    name: 'MightyIT',
    slug: 'mightyit',
    superopsSubdomain: 'x',
    superopsApiKey: 'k',
    dryRun: true,
    cippEnabled: true,
    cippApiUrl: 'https://cipp.test',
    cippTenantId: 'msp',
    cippClientId: 'client',
    cippClientSecret: encrypt('secret', process.env.ENCRYPTION_KEY!),
    executionPolicy: JSON.stringify({
      mode: 'live',
      actions: ['password_reset', 'group_add', 'group_remove', 'license_assign', 'license_remove', 'account_disable'],
      clientIds: ['c1'],
      requireDryRun: true,
    }),
  });
  await db.insert(clients).values({
    id: 'c1',
    tenantId: 't1',
    name: 'Acme',
    automationEnabled: true,
    emailDomains: JSON.stringify(['acme.com']),
    m365DefaultDomain: 'acme.onmicrosoft.com',
  });
});

beforeEach(() => {
  state = baseState();
  vi.stubGlobal('fetch', createFakeCipp(state));
});

afterAll(() => vi.unstubAllGlobals());

async function proposal(action: string, entities: Record<string, string | null>, extra: Record<string, unknown> = {}) {
  const { db } = await import('../src/db');
  const { actionLogs, approvals } = await import('../src/db/schema');
  const id = `log-${++seq}`;
  await db.insert(actionLogs).values({
    id,
    tenantId: 't1',
    clientId: 'c1',
    ticketId: `T-${seq}`,
    classification: action,
    confidence: 0.95,
    status: 'classified',
    entities: JSON.stringify({ target_user_email: null, target_user_display_name: null, group_name: null, license_sku: null, ...entities }),
    tenancy: JSON.stringify({ crossTenant: false, m365: { defaultDomain: 'acme.onmicrosoft.com', tenantId: null } }),
    executionPlan: JSON.stringify({ blockers: [] }),
    approvalState: 'approved',
    approvalsRequired: 1,
    ...extra,
  });
  await db.insert(approvals).values({
    id: `ap-${seq}`,
    actionLogId: id,
    userId: 'admin-1',
    userEmail: admin.email,
    decision: 'approved',
    verificationMethod: 'callback_known_number',
  });
  return id;
}

async function run(logId: string, mode: 'dry_run' | 'live') {
  const { executionId } = await ex.startExecution(logId, mode, admin, { await: true });
  const runs = await ex.listExecutions(logId);
  return runs.find((r) => r.id === executionId)!;
}

async function dryThenLive(logId: string) {
  const dry = await run(logId, 'dry_run');
  expect(dry.status).toBe('dry_run_ok');
  return run(logId, 'live');
}

describe('readiness', () => {
  it('requires a dry run before going live', async () => {
    const id = await proposal('group_add', { target_user_email: 'sam@acme.com', group_name: 'Finance' });
    const r = await ex.executionReadiness(id, admin);
    expect(r.canDryRun).toBe(true);
    expect(r.canRunLive).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/dry run first/i);
  });

  it('refuses a pending proposal, an action not on the list, and a crossed-client request', async () => {
    const pending = await proposal('group_add', { target_user_email: 'sam@acme.com', group_name: 'Finance' }, { approvalState: 'pending' });
    expect((await ex.executionReadiness(pending, admin)).reasons.join(' ')).toMatch(/Waiting for approval/);
    const mfa = await proposal('mfa_reset', { target_user_email: 'sam@acme.com' });
    expect((await ex.executionReadiness(mfa, admin)).reasons.join(' ')).toMatch(/not on the list/);
    const crossed = await proposal('group_add', { target_user_email: 'sam@acme.com', group_name: 'Finance' }, { crossTenant: true });
    const r = await ex.executionReadiness(crossed, admin);
    expect(r.canDryRun).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/crosses clients/);
  });

  it('needs an attested human approval for identity-sensitive changes', async () => {
    const { db } = await import('../src/db');
    const { approvals } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const id = await proposal('password_reset', { target_user_email: 'sam@acme.com' });
    await db.update(approvals).set({ verificationMethod: null }).where(eq(approvals.actionLogId, id));
    expect((await ex.executionReadiness(id, admin)).reasons.join(' ')).toMatch(/identity was confirmed/);
    const auto = await proposal('password_reset', { target_user_email: 'sam@acme.com' }, { approvalState: 'auto_approved' });
    expect((await ex.executionReadiness(auto, admin)).reasons.join(' ')).toMatch(/not auto-approval/);
  });

  it('honours the install-wide kill switch', async () => {
    const { config, setConfigForTesting } = await import('../src/config');
    const original = config();
    setConfigForTesting({ ...original, executionDisabled: true });
    try {
      const id = await proposal('group_add', { target_user_email: 'sam@acme.com', group_name: 'Finance' });
      const r = await ex.executionReadiness(id, admin);
      expect(r.mode).toBe('off');
      await expect(ex.startExecution(id, 'dry_run', admin)).rejects.toThrow(/whole install/);
    } finally {
      setConfigForTesting(original);
    }
  });
});

describe('resolving against the tenant', () => {
  it('builds the group change from the user’s object id and the exact group', async () => {
    const id = await proposal('group_add', { target_user_email: 'sam@acme.com', group_name: 'finance' });
    const dry = await run(id, 'dry_run');
    expect(dry.status).toBe('dry_run_ok');
    const post = dry.steps.find((s) => s.method === 'POST')!;
    expect(post.status).toBe('planned');
    expect(post.payload).toMatchObject({ groupId: { value: 'g-fin' }, AddMember: [{ value: 'u-sam' }] });
    expect(state.writes).toEqual([]);
  });

  it('blocks an ambiguous, dynamic or privileged group and a missing one', async () => {
    for (const [name, pattern] of [
      ['Sales', /2 groups/],
      ['All Staff', /dynamic/],
      ['Helpdesk Admins', /admin roles/],
      ['Fin', /exactly/],
    ] as const) {
      const id = await proposal('group_add', { target_user_email: 'sam@acme.com', group_name: name });
      const dry = await run(id, 'dry_run');
      expect(dry.status).toBe('blocked');
      expect(dry.summary).toMatch(pattern);
    }
  });

  it('refuses a user on a domain the client does not own', async () => {
    const id = await proposal('group_add', { target_user_email: 'sam@globex.com', group_name: 'Finance' });
    const dry = await run(id, 'dry_run');
    expect(dry.status).toBe('blocked');
    expect(dry.summary).toMatch(/not on a domain Acme owns/);
  });

  it('refuses to assign a licence with none free, and reports a no-op without sending', async () => {
    const none = await proposal('license_assign', { target_user_email: 'tom@acme.com', license_sku: 'Business Premium' });
    expect((await run(none, 'dry_run')).summary).toMatch(/No free Microsoft 365 Business Premium/);
    state.groups[0].members.push('u-sam');
    const noop = await proposal('group_add', { target_user_email: 'sam@acme.com', group_name: 'Finance' });
    const dry = await run(noop, 'dry_run');
    expect(dry.summary).toMatch(/already in "Finance"/);
    expect(state.writes).toEqual([]);
  });

  it('blocks disabling an account synced from on-premises AD', async () => {
    const id = await proposal('account_disable', { target_user_email: 'old@acme.com' });
    expect((await run(id, 'dry_run')).summary).toMatch(/syncs from on-premises AD/);
  });
});

describe('live runs', () => {
  it('adds to a group, reads it back, and will not run twice', async () => {
    const id = await proposal('group_add', { target_user_email: 'sam@acme.com', group_name: 'Finance' });
    const live = await dryThenLive(id);
    expect(live.status).toBe('succeeded');
    expect(live.verification).toBe('verified');
    expect(state.groups[0].members).toContain('u-sam');
    expect(state.writes).toHaveLength(1);
    await expect(ex.startExecution(id, 'live', admin)).rejects.toThrow(/already been made/);
    expect(state.writes).toHaveLength(1);
  });

  it('keeps the proposal marked done when someone dry-runs it again afterwards', async () => {
    const { db } = await import('../src/db');
    const { actionLogs } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const id = await proposal('group_add', { target_user_email: 'sam@acme.com', group_name: 'Finance' });
    const dry = await run(id, 'dry_run');
    let [row] = await db.select().from(actionLogs).where(eq(actionLogs.id, id));
    expect(dry.status).toBe('dry_run_ok');
    expect(row.executionState).toBeNull();
    await run(id, 'live');
    const again = await run(id, 'dry_run');
    expect(again.summary).toMatch(/Nothing to do/);
    [row] = await db.select().from(actionLogs).where(eq(actionLogs.id, id));
    expect(row.executionState).toBe('succeeded');
  });

  it('treats CIPP’s "Success" as unproven until the tenant shows it', async () => {
    state.mode.editGroupSilentNoop = true;
    const id = await proposal('group_add', { target_user_email: 'tom@acme.com', group_name: 'Finance' });
    const live = await dryThenLive(id);
    expect(live.status).toBe('uncertain');
    expect(live.summary).toMatch(/not visible in the tenant/);
  });

  it('resets a password without the password reaching any record, and reveals it once', async () => {
    const id = await proposal('password_reset', { target_user_email: 'sam@acme.com' });
    const live = await dryThenLive(id);
    expect(live.status).toBe('succeeded');
    expect(live.verification).toBe('verified');
    expect(live.hasSecret).toBe(true);
    expect(JSON.stringify(live)).not.toContain('Swoop-Temp-123!');

    const { db } = await import('../src/db');
    const { executions, auditLog } = await import('../src/db/schema');
    const stored = JSON.stringify(await db.select().from(executions));
    expect(stored).not.toContain('Swoop-Temp-123!');

    expect(await ex.revealSecret(live.id, admin)).toBe('Swoop-Temp-123!');
    await expect(ex.revealSecret(live.id, admin)).rejects.toThrow(/Already revealed/);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain('Swoop-Temp-123!');
  });

  it('removes a licence using the field CIPP actually reads', async () => {
    const id = await proposal('license_remove', { target_user_email: 'sam@acme.com', license_sku: 'Microsoft 365 Business Premium' });
    const live = await dryThenLive(id);
    expect(live.status).toBe('succeeded');
    expect(state.writes[0].body).toEqual([expect.objectContaining({ LicenseOperation: 'Remove', LicensesToRemove: [{ label: 'Microsoft 365 Business Premium', value: 'sku-bp' }] })]);
    expect(state.users[0].assignedLicenses).toEqual([]);
  });

  it('disables an account and signs it out, verifying the block', async () => {
    const id = await proposal('account_disable', { target_user_email: 'tom@acme.com' });
    const live = await dryThenLive(id);
    expect(live.status).toBe('succeeded');
    expect(state.writes.map((w) => w.endpoint)).toEqual(['ExecDisableUser', 'ExecRevokeSessions']);
    expect(state.users[1].accountEnabled).toBe(false);
  });

  it('records a failure CIPP reports, and allows a fresh attempt', async () => {
    state.mode.failOn = 'EditGroup';
    const id = await proposal('group_add', { target_user_email: 'tom@acme.com', group_name: 'Finance' });
    const live = await dryThenLive(id);
    expect(live.status).toBe('failed');
    expect(live.summary).toMatch(/Insufficient privileges/);
    const { db } = await import('../src/db');
    const { auditLog } = await import('../src/db/schema');
    const { and, eq } = await import('drizzle-orm');
    const audited = await db.select().from(auditLog).where(and(eq(auditLog.action, 'execution.failed'), eq(auditLog.targetId, id)));
    expect(audited).toHaveLength(1);
    state.mode.failOn = undefined;
    expect((await run(id, 'live')).status).toBe('succeeded');
  });

  it('marks a request with no answer as uncertain and blocks retries until a person resolves it', async () => {
    state.mode.hangOn = 'EditGroup';
    const id = await proposal('group_add', { target_user_email: 'tom@acme.com', group_name: 'Finance' });
    const live = await dryThenLive(id);
    expect(live.status).toBe('uncertain');
    state.mode.hangOn = undefined;
    await expect(ex.startExecution(id, 'live', admin)).rejects.toThrow(/outcome is unknown/);
    await ex.resolveUncertain(live.id, 'failed', 'Checked in Entra: not added', admin);
    expect((await run(id, 'live')).status).toBe('succeeded');
  });
});

describe('interpreting CIPP', () => {
  it('reads CIPP’s error lines as failures even with HTTP 200', () => {
    expect(ex.interpret('group_add', 'EditGroup', 200, { Results: ['Error - Failed to add member'] }).ok).toBe(false);
    expect(ex.interpret('group_add', 'EditGroup', 200, { Results: ['Success - Added member'] }).ok).toBe(true);
    expect(ex.interpret('password_reset', 'ExecResetPass', 200, { Results: { resultText: 'x', copyField: '', state: 'success' } }).ok).toBe(false);
  });
});

describe('the write path', () => {
  it('is imported by the executor and nothing else', () => {
    const root = path.join(__dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.ts$/.test(entry.name) && !full.endsWith(path.join('cipp', 'writer.ts'))) {
          if (/from ['"][./]*.*cipp\/writer['"]/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([path.join('services', 'execution', 'executor.ts')]);
  });
});
