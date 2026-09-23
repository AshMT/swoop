import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * People, roles, sessions and approvals, through the HTTP API.
 */

let app: Express;
const tokens: Record<string, string> = {};
let tenantId = '';
let clientId = '';

const PASSWORD = 'a-very-long-test-password';

beforeAll(async () => {
  const { initializeDatabase } = await import('../src/db');
  const { createApp } = await import('../src/server');
  initializeDatabase();
  app = createApp();

  const admin = await request(app).post('/api/setup/admin').send({ email: 'admin@msp.test', password: PASSWORD }).expect(200);
  tokens.admin = admin.body.token;
  const tenant = await as('admin', request(app).post('/api/setup/tenant'))
    .send({ name: 'MightyIT', subdomain: 'mightyit', apiKey: 'k', region: 'us' })
    .expect(200);
  tenantId = tenant.body.id;
  const client = await as('admin', request(app).post('/api/clients'))
    .send({ tenantId, name: 'Acme', superopsCompanyId: '100', emailDomains: ['acme.com'], m365DefaultDomain: 'acme.onmicrosoft.com' })
    .expect(201);
  clientId = client.body.id;
});

function as(who: string, req: request.Test) {
  return req.set('Authorization', `Bearer ${tokens[who]}`);
}

async function invite(email: string, role: string): Promise<string> {
  const res = await as('admin', request(app).post('/api/users/invites')).send({ email, role }).expect(201);
  return res.body.token as string;
}

describe('invitations', () => {
  it('only an admin can invite', async () => {
    await request(app).post('/api/users/invites').send({ email: 'x@msp.test', role: 'viewer' }).expect(401);
  });

  it('shows and accepts an invitation once', async () => {
    const token = await invite('viewer@msp.test', 'viewer');
    const info = await request(app).get(`/api/auth/invite/${token}`).expect(200);
    expect(info.body).toMatchObject({ email: 'viewer@msp.test', role: 'viewer' });

    await request(app).post('/api/auth/accept-invite').send({ token, password: 'short' }).expect(400);
    const accepted = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: PASSWORD, displayName: 'Vee' })
      .expect(200);
    tokens.viewer = accepted.body.token;
    await request(app).post('/api/auth/accept-invite').send({ token, password: PASSWORD }).expect(404);
  });

  it('a re-invite replaces the earlier link', async () => {
    const first = await invite('twice@msp.test', 'viewer');
    await invite('twice@msp.test', 'reviewer');
    await request(app).get(`/api/auth/invite/${first}`).expect(404);
  });

  it('refuses to invite an existing account', async () => {
    await as('admin', request(app).post('/api/users/invites')).send({ email: 'viewer@msp.test', role: 'admin' }).expect(409);
  });

  it('creates reviewer and two approvers', async () => {
    for (const [who, role] of [['reviewer', 'reviewer'], ['approver', 'approver'], ['approver2', 'approver']]) {
      const token = await invite(`${who}@msp.test`, role);
      const res = await request(app).post('/api/auth/accept-invite').send({ token, password: PASSWORD }).expect(200);
      tokens[who] = res.body.token;
    }
    const me = await as('approver', request(app).get('/api/auth/me')).expect(200);
    expect(me.body.role).toBe('approver');
  });
});

describe('role enforcement', () => {
  it('lets a viewer read but not change anything', async () => {
    await as('viewer', request(app).get('/api/actions')).expect(200);
    await as('viewer', request(app).patch(`/api/tenants/${tenantId}`)).send({ dryRun: true }).expect(403);
    await as('viewer', request(app).patch(`/api/clients/${clientId}`)).send({ name: 'X' }).expect(403);
    await as('viewer', request(app).post('/api/setup/tenant')).send({ name: 'x', subdomain: 'x', apiKey: 'x' }).expect(403);
    await as('viewer', request(app).get('/api/users')).expect(403);
  });

  it('lets a reviewer review but not change settings', async () => {
    await as('reviewer', request(app).patch(`/api/tenants/${tenantId}`)).send({ dryRun: true }).expect(403);
  });

  it('never returns the CIPP secret', async () => {
    await as('admin', request(app).patch(`/api/tenants/${tenantId}`))
      .send({ cippApiUrl: 'https://cipp.example.com', cippTenantId: 't', cippClientId: 'c', cippClientSecret: 'hunter2-cipp-secret' })
      .expect(200);
    const res = await as('admin', request(app).get(`/api/tenants/${tenantId}`)).expect(200);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(res.body.hasCippClientSecret).toBe(true);
  });

  it('validates client domains and refuses a shared one', async () => {
    await as('admin', request(app).post('/api/clients'))
      .send({ tenantId, name: 'Personal', emailDomains: ['gmail.com'] })
      .expect(400);
    const clash = await as('admin', request(app).post('/api/clients'))
      .send({ tenantId, name: 'Acme Twin', emailDomains: ['ACME.com'] })
      .expect(409);
    expect(clash.body.error).toMatch(/already belongs to Acme/);
  });
});

describe('sessions', () => {
  it('revokes other sessions on password change', async () => {
    const old = tokens.viewer;
    const res = await as('viewer', request(app).post('/api/auth/change-password'))
      .send({ currentPassword: PASSWORD, newPassword: `${PASSWORD}-2` })
      .expect(200);
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${old}`).expect(401);
    tokens.viewer = res.body.token;
    await as('viewer', request(app).get('/api/auth/me')).expect(200);
  });

  it('disabling a user ends their session and blocks sign-in', async () => {
    const list = await as('admin', request(app).get('/api/users')).expect(200);
    const viewer = list.body.users.find((u: { email: string }) => u.email === 'viewer@msp.test');
    await as('admin', request(app).patch(`/api/users/${viewer.id}`)).send({ disabled: true }).expect(200);
    await as('viewer', request(app).get('/api/auth/me')).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'viewer@msp.test', password: `${PASSWORD}-2` }).expect(403);
  });

  it('will not leave Swoop without an admin', async () => {
    const list = await as('admin', request(app).get('/api/users')).expect(200);
    const admin = list.body.users.find((u: { email: string }) => u.email === 'admin@msp.test');
    await as('admin', request(app).patch(`/api/users/${admin.id}`)).send({ role: 'viewer' }).expect(400);
  });
});

describe('approvals', () => {
  let logId = '';

  beforeAll(async () => {
    const { db } = await import('../src/db');
    const { actionLogs } = await import('../src/db/schema');
    logId = '11111111-1111-4111-8111-111111111111';
    await db.insert(actionLogs).values({
      id: logId,
      tenantId,
      clientId,
      ticketId: 'T-1',
      ticketSubject: 'Reset MFA for sam',
      classification: 'mfa_reset',
      confidence: 0.95,
      sensitivity: 'normal',
      status: 'classified',
      priority: 'P3',
      approvalState: 'pending',
      approvalsRequired: 2,
      approvalExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  it('shows up in the pending queue', async () => {
    const res = await as('viewer2' in tokens ? 'viewer2' : 'reviewer', request(app).get('/api/actions?approval=pending')).expect(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toContain(logId);
    const summary = await as('reviewer', request(app).get('/api/actions/queue-summary')).expect(200);
    expect(summary.body.pendingApprovals).toBe(1);
  });

  it('a reviewer cannot approve', async () => {
    await as('reviewer', request(app).post(`/api/actions/${logId}/approve`)).send({}).expect(403);
  });

  it('an MFA reset cannot be approved without saying how the requester was verified', async () => {
    const res = await as('approver', request(app).post(`/api/actions/${logId}/approve`)).send({ comment: 'ok' }).expect(400);
    expect(res.body.error).toMatch(/identity/);
    await as('approver', request(app).post(`/api/actions/${logId}/approve`))
      .send({ verificationMethod: 'other' })
      .expect(400);
  });

  it('dual approval needs two different people', async () => {
    const verified = { verificationMethod: 'callback_known_number' };
    const first = await as('approver', request(app).post(`/api/actions/${logId}/approve`)).send({ comment: 'ok', ...verified }).expect(200);
    expect(first.body).toMatchObject({ state: 'pending', approvals: 1, required: 2 });
    await as('approver', request(app).post(`/api/actions/${logId}/approve`)).send(verified).expect(409);
    const second = await as('approver2', request(app).post(`/api/actions/${logId}/approve`)).send(verified).expect(200);
    expect(second.body.state).toBe('approved');
  });

  it('records the decision trail and marks the triage correct', async () => {
    const detail = await as('reviewer', request(app).get(`/api/actions/${logId}`)).expect(200);
    expect(detail.body.approvalState).toBe('approved');
    expect(detail.body.reviewVerdict).toBe('correct');
    expect(detail.body.decisions.map((d: { userEmail: string }) => d.userEmail)).toEqual(['approver@msp.test', 'approver2@msp.test']);
  });

  it('cannot decide twice on a closed proposal', async () => {
    await as('admin', request(app).post(`/api/actions/${logId}/reject`)).send({ reason: 'other' }).expect(409);
  });

  it('writes the audit log', async () => {
    const res = await as('admin', request(app).get('/api/users/audit?action=approval')).expect(200);
    expect(res.body.map((e: { action: string }) => e.action)).toEqual(['approval.approve', 'approval.approve']);
    await as('approver', request(app).get('/api/users/audit')).expect(403);
  });

  it('a rejection needs a reason and ends the proposal', async () => {
    const { db } = await import('../src/db');
    const { actionLogs } = await import('../src/db/schema');
    const id = '22222222-2222-4222-8222-222222222222';
    await db.insert(actionLogs).values({
      id, tenantId, clientId, ticketId: 'T-2', classification: 'group_add', confidence: 0.9, status: 'classified',
      approvalState: 'pending', approvalsRequired: 1, approvalExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await as('approver', request(app).post(`/api/actions/${id}/reject`)).send({}).expect(400);
    const res = await as('approver', request(app).post(`/api/actions/${id}/reject`)).send({ reason: 'wrong_action' }).expect(200);
    expect(res.body.state).toBe('rejected');
    const detail = await as('reviewer', request(app).get(`/api/actions/${id}`)).expect(200);
    expect(detail.body.reviewVerdict).toBe('incorrect');
  });

  it('expires a proposal nobody decided on', async () => {
    const { db } = await import('../src/db');
    const { actionLogs } = await import('../src/db/schema');
    const id = '33333333-3333-4333-8333-333333333333';
    await db.insert(actionLogs).values({
      id, tenantId, clientId, ticketId: 'T-3', classification: 'group_add', confidence: 0.9, status: 'classified',
      approvalState: 'pending', approvalsRequired: 1, approvalExpiresAt: Math.floor(Date.now() / 1000) - 10,
    });
    await as('approver', request(app).post(`/api/actions/${id}/approve`)).send({}).expect(409);
    const detail = await as('reviewer', request(app).get(`/api/actions/${id}`)).expect(200);
    expect(detail.body.approvalState).toBe('expired');
  });
});

describe('per-dimension calibration', () => {
  it('scores the action, category and priority separately', async () => {
    const { db } = await import('../src/db');
    const { actionLogs } = await import('../src/db/schema');
    const base = { tenantId, clientId, confidence: 0.9, status: 'classified', classification: 'ESCALATE', category: 'printing' };
    await db.insert(actionLogs).values([
      // Right on everything.
      { ...base, id: 'd1111111-1111-4111-8111-111111111111', ticketId: 'D-1', priority: 'P3' },
      // Action right, priority under-called.
      { ...base, id: 'd2222222-2222-4222-8222-222222222222', ticketId: 'D-2', priority: 'P4' },
      // Action right, category wrong.
      { ...base, id: 'd3333333-3333-4333-8333-333333333333', ticketId: 'D-3', priority: 'P3' },
    ]);
    await as('reviewer', request(app).post('/api/actions/d1111111-1111-4111-8111-111111111111/review')).send({ verdict: 'correct' }).expect(200);
    await as('reviewer', request(app).post('/api/actions/d2222222-2222-4222-8222-222222222222/review'))
      .send({ verdict: 'incorrect', correctPriority: 'P2' })
      .expect(200);
    await as('reviewer', request(app).post('/api/actions/d3333333-3333-4333-8333-333333333333/review'))
      .send({ verdict: 'incorrect', correctCategory: 'network' })
      .expect(200);
    await as('reviewer', request(app).post('/api/actions/d3333333-3333-4333-8333-333333333333/review'))
      .send({ verdict: 'incorrect', correctCategory: 'astrology' })
      .expect(400);

    const res = await as('viewer2' in tokens ? 'viewer2' : 'reviewer', request(app).get(`/api/actions/metrics?tenantId=${tenantId}`)).expect(200);
    const escalate = res.body.byClassification.find((b: { classification: string }) => b.classification === 'ESCALATE');
    expect(escalate).toMatchObject({ reviewed: 3, correct: 3 });
    // The approved MFA reset from earlier also carries a priority.
    expect(res.body.dimensions.priority).toMatchObject({ reviewed: 4, correct: 3, tooLow: 1, tooHigh: 0 });
    expect(res.body.dimensions.category).toMatchObject({ reviewed: 3, correct: 2 });
    expect(res.body.dimensions.category.confusion[0]).toMatchObject({ predicted: 'printing', actual: 'network' });
  });
});

describe('execution, agent and knowledge settings', () => {
  it('keeps execution off until an admin allowlists actions and this tenant’s clients', async () => {
    const policies = await as('admin', request(app).get(`/api/tenants/${tenantId}/policies`)).expect(200);
    expect(policies.body.executionPolicy).toMatchObject({ mode: 'off', actions: [], clientIds: [] });
    expect(policies.body.agentSettings).toMatchObject({ enabled: false });

    await as('approver', request(app).patch(`/api/tenants/${tenantId}`))
      .send({ executionPolicy: { mode: 'live', actions: ['group_add'], clientIds: [clientId] } })
      .expect(403);
    await as('admin', request(app).patch(`/api/tenants/${tenantId}`))
      .send({ executionPolicy: { mode: 'live', actions: ['mailbox_permission'], clientIds: [clientId] } })
      .expect(400);
    const foreign = await as('admin', request(app).patch(`/api/tenants/${tenantId}`))
      .send({ executionPolicy: { mode: 'live', actions: ['group_add'], clientIds: ['not-a-client-here'] } })
      .expect(400);
    expect(foreign.body.error).toMatch(/not in this tenant/);

    await as('admin', request(app).patch(`/api/tenants/${tenantId}`))
      .send({ executionPolicy: { mode: 'dry_run', actions: ['group_add'], clientIds: [clientId] } })
      .expect(200);
    const audit = await as('admin', request(app).get('/api/users/audit?limit=20')).expect(200);
    const actions = (audit.body.items ?? audit.body).map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['execution.mode_change', 'execution.policy_change']));
    await as('admin', request(app).patch(`/api/tenants/${tenantId}`)).send({ executionPolicy: { mode: 'off' } }).expect(200);
  });

  it('only approvers run changes or reveal secrets, and nothing runs while execution is off', async () => {
    const { db } = await import('../src/db');
    const { actionLogs } = await import('../src/db/schema');
    const id = 'e1111111-1111-4111-8111-111111111111';
    await db.insert(actionLogs).values({
      id,
      tenantId,
      clientId,
      ticketId: 'T-EXEC',
      classification: 'group_add',
      confidence: 0.95,
      status: 'classified',
      approvalState: 'approved',
      entities: JSON.stringify({ target_user_email: 'sam@acme.com', group_name: 'Finance' }),
    });
    await as('reviewer', request(app).post(`/api/actions/${id}/execute`)).send({ mode: 'dry_run' }).expect(403);
    await as('reviewer', request(app).post('/api/actions/executions/anything/reveal')).expect(403);
    const refused = await as('approver', request(app).post(`/api/actions/${id}/execute`)).send({ mode: 'dry_run' }).expect(409);
    expect(refused.body.error).toMatch(/Execution is off/);
    const state = await as('reviewer', request(app).get(`/api/actions/${id}/executions`)).expect(200);
    expect(state.body.readiness).toMatchObject({ mode: 'off', canDryRun: false, canRunLive: false });
  });

  it('will not investigate while the agent is off', async () => {
    const res = await as('reviewer', request(app).post('/api/actions/e1111111-1111-4111-8111-111111111111/investigate')).expect(400);
    expect(res.body.error).toMatch(/agent is off/);
    const detail = await as('reviewer', request(app).get('/api/actions/e1111111-1111-4111-8111-111111111111')).expect(200);
    expect(detail.body.agentEnabled).toBe(false);
  });

  it('lets reviewers write runbooks and searches them per client', async () => {
        await as('reviewer', request(app).post('/api/knowledge'))
      .send({ tenantId, clientId, title: 'Acme finance', body: 'Finance access means the Finance security group.' })
      .expect(201);
    const general = await as('reviewer', request(app).get(`/api/knowledge/search?tenantId=${tenantId}&q=finance%20access&scope=general`)).expect(200);
    expect(general.body).toEqual([]);
    const scoped = await as('reviewer', request(app).get(`/api/knowledge/search?tenantId=${tenantId}&q=finance%20access&clientId=${clientId}`)).expect(200);
    expect(scoped.body[0]).toMatchObject({ title: 'Acme finance', clientSpecific: true });
    const all = await as('reviewer', request(app).get(`/api/knowledge/search?tenantId=${tenantId}&q=finance%20access&scope=all`)).expect(200);
    expect(all.body).toHaveLength(1);
  });
});
