import './setup-env';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client, Tenant } from '../src/types';
import type { PsaTicket } from '../src/services/psa/interface';
import type { SuperOpsClient } from '../src/services/psa/superops';

/**
 * The whole triage pipeline against a real (in-memory) database, with the
 * model and the PSA stubbed. The model stub answers from the ticket subject so
 * each test controls what "the AI said".
 */

type RunTriage = typeof import('../src/services/triage/pipeline').runTriage;
let runTriage: RunTriage;
let tenant: Tenant;
let acme: Client;
let globex: Client;
const notes: Array<{ ticketId: string; note: string }> = [];
const prompts: string[] = [];

const psa = {
  addTicketNote: vi.fn(async (ticketId: string, note: string) => {
    notes.push({ ticketId, note });
  }),
} as unknown as SuperOpsClient;

function answerFor(subject: string): Record<string, unknown> {
  const base = {
    confidence: 0.93,
    sensitivity: 'normal',
    entities: { target_user_email: null, target_user_display_name: null, group_name: null, license_sku: null },
    reasoning: 'Stub.',
    follow_up_question: null,
    escalation_reason: null,
    proposed_psa_note: 'Stub note.',
    subcategory: null,
    summary: subject,
    sentiment: 'neutral',
    first_response: 'Thanks, we are on it.',
    next_steps: ['Look into it'],
  };
  if (/reset/i.test(subject)) {
    const email = /([a-z.]+@[a-z.]+)/i.exec(subject)?.[1] ?? null;
    return {
      ...base,
      classification: 'password_reset',
      entities: { ...base.entities, target_user_email: email },
      category: 'identity_access',
      impact: 'individual',
      urgency: 'blocking',
    };
  }
  return { ...base, classification: 'ESCALATE', escalation_reason: 'Needs hands-on work', category: 'email_collab', impact: 'individual', urgency: 'degraded' };
}

beforeAll(async () => {
  const { initializeDatabase, db } = await import('../src/db');
  const { tenants, clients } = await import('../src/db/schema');
  initializeDatabase();
  ({ runTriage } = await import('../src/services/triage/pipeline'));

  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    if (!String(url).endsWith('/chat/completions')) throw new Error(`Unexpected fetch ${url}`);
    const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
    const user = body.messages[1].content;
    prompts.push(user);
    const subject = /TICKET SUBJECT: (.*)/.exec(user)?.[1] ?? '';
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(answerFor(subject)) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });

  await db.insert(tenants).values({
    id: 't1', name: 'MightyIT', slug: 'mightyit', superopsSubdomain: 'x', superopsApiKey: 'k',
    aiBaseUrl: 'http://ai.test/v1', aiModel: 'stub', confidenceThreshold: 0.75,
    // Always in hours, so the result does not depend on when the suite runs.
    triageSettings: JSON.stringify({ businessHours: { timezone: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' } }),
  });
  await db.insert(clients).values([
    { id: 'c1', tenantId: 't1', name: 'Acme', superopsCompanyId: '100', automationEnabled: true, emailDomains: JSON.stringify(['acme.com']), m365DefaultDomain: 'acme.onmicrosoft.com', vipEmails: JSON.stringify(['boss@acme.com']) },
    { id: 'c2', tenantId: 't1', name: 'Globex', superopsCompanyId: '200', automationEnabled: true, emailDomains: JSON.stringify(['globex.com']) },
  ]);
  const { eq } = await import('drizzle-orm');
  [tenant] = await db.select().from(tenants).where(eq(tenants.id, 't1'));
  [acme] = await db.select().from(clients).where(eq(clients.id, 'c1'));
  [globex] = await db.select().from(clients).where(eq(clients.id, 'c2'));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

let seq = 0;
function ticket(subject: string, requesterEmail: string, body = ''): PsaTicket {
  seq++;
  return {
    ticketId: `T-${seq}`, displayId: String(1000 + seq), subject, body, status: null, priority: null,
    createdAt: null, clientId: null, clientName: null, requesterEmail, requesterName: null,
  };
}

function run(t: PsaTicket, client: Client = acme) {
  return runTriage({ tenant, client, matchMethod: 'company_id', allClients: [acme, globex], ticket: t, psa, postNote: true, previewNote: false });
}

describe('runTriage', () => {
  it('produces a full verdict, a plan and a pending approval', async () => {
    const out = await run(ticket('Password reset for sam@acme.com', 'bob@acme.com'));
    expect(out.outcome.priority).toBe('P3');
    expect(out.outcome.queue).toBe('Service desk');
    expect(out.approval.state).toBe('pending');
    expect(out.plan?.tenant).toBe('acme.onmicrosoft.com');
    expect(out.plan?.steps.map((s) => s.endpoint)).toContain('/api/ExecResetPass');
    expect(notes.at(-1)?.note).toMatch(/Priority: P3 Medium/);
    expect(notes.at(-1)?.note).toMatch(/Waiting for one approval/);
  });

  it('escalates a request from one client for another client’s user', async () => {
    const out = await run(ticket('Password reset for ceo@globex.com', 'bob@acme.com'));
    expect(out.outcome.classification.classification).toBe('ESCALATE');
    expect(out.outcome.queue).toBe('Security');
    expect(out.approval.state).toBe('not_required');
    expect(notes.at(-1)?.note).toMatch(/Targets another client/);
  });

  it('bumps a VIP and tells the model', async () => {
    const out = await run(ticket('Password reset for sam@acme.com', 'boss@acme.com'));
    expect(out.outcome.priority).toBe('P2');
    expect(prompts.at(-1)).toMatch(/VIP list/);
  });

  it('does not treat several resets for different people as an incident', async () => {
    const out = await run(ticket('Password reset for tom@acme.com', 'bob@acme.com'));
    expect(out.cluster).toBeNull();
  });

  it('routes an urgent ticket to on-call out of hours', async () => {
    const night = { ...tenant, triageSettings: JSON.stringify({ businessHours: { timezone: 'UTC', days: [], start: '09:00', end: '17:00' } }) };
    const out = await runTriage({
      tenant: night, client: acme, matchMethod: 'company_id', allClients: [acme, globex],
      ticket: ticket('Password reset for ceo@globex.com', 'bob@acme.com'), psa, postNote: false, previewNote: true,
    });
    expect(out.outcome.queue).toBe('On-call');
  });

  it('spots a duplicate from the same requester', async () => {
    await run(ticket('Shared calendar not syncing on my phone', 'amy@acme.com'));
    const out = await run(ticket('Shared calendar not syncing on my phone again', 'amy@acme.com'));
    expect(out.outcome.signals.map((s) => s.id)).toContain('possible_duplicate');
  });

  it('clusters a burst of similar tickets across clients', async () => {
    await run(ticket('Outlook cannot connect to Exchange server', 'a@acme.com'));
    await run(ticket('Outlook cannot connect to Exchange', 'b@globex.com'), globex);
    const third = await run(ticket('Outlook says cannot connect to Exchange', 'c@acme.com'));
    expect(third.cluster).not.toBeNull();
    expect(third.cluster?.crossClient).toBe(true);
    expect(third.cluster?.size).toBeGreaterThanOrEqual(3);
    expect(third.outcome.priority).toBe('P2');

    const { db } = await import('../src/db');
    const { actionLogs } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const members = await db.select().from(actionLogs).where(eq(actionLogs.clusterId, third.cluster!.clusterId));
    expect(members.length).toBeGreaterThanOrEqual(2);
  });

  it('shows reviewed tickets to the model as examples', async () => {
    const { db } = await import('../src/db');
    const { actionLogs } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const first = await run(ticket('Scanner will not send to email', 'dan@acme.com'));
    await db.update(actionLogs).set({ reviewVerdict: 'incorrect', reviewCorrectCategory: 'printing' }).where(eq(actionLogs.id, first.logId));
    await run(ticket('Scanner will not send scans to email', 'eve@acme.com'));
    expect(prompts.at(-1)).toMatch(/SIMILAR PAST TICKETS/);
    expect(prompts.at(-1)).toMatch(/→ printing/);
  });

  it('supersedes a pending proposal when the ticket is re-run', async () => {
    const t = ticket('Password reset for zoe@acme.com', 'bob@acme.com');
    const first = await run(t);
    const second = await run(t);
    const { db } = await import('../src/db');
    const { actionLogs } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const [old] = await db.select().from(actionLogs).where(eq(actionLogs.id, first.logId));
    expect(old.approvalState).toBe('superseded');
    expect(old.supersededBy).toBe(second.logId);
  });
});
