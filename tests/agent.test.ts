import './setup-env';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseState, createFakeCipp, type FakeState } from './helpers/fake-cipp';
import type { Client, Tenant } from '../src/types';

/**
 * The investigation agent, with a scripted tool-calling model and the fake
 * CIPP. The model's script is a list of turns: tool calls, then a final answer.
 */

type Agent = typeof import('../src/services/agent/investigate');
let agent: Agent;
let tenant: Tenant;
let client: Client;
let cipp: FakeState;
let script: Array<{ tool_calls?: Array<{ name: string; args: Record<string, unknown> }>; content?: string }> = [];
let requests: Array<{ tools?: unknown; messages: Array<{ role: string; content: string | null }> }> = [];
let rejectTools = false;

beforeAll(async () => {
  const { initializeDatabase, db } = await import('../src/db');
  const { tenants, clients, runbooks } = await import('../src/db/schema');
  const { encrypt } = await import('../src/services/crypto');
  const { eq } = await import('drizzle-orm');
  initializeDatabase();
  agent = await import('../src/services/agent/investigate');
  await db.insert(tenants).values({
    id: 't1', name: 'MightyIT', slug: 'm', superopsSubdomain: 'x', superopsApiKey: 'k',
    aiBaseUrl: 'https://ai.test/v1', aiModel: 'triage-model',
    agentSettings: JSON.stringify({ enabled: true, autoRun: 'actions', model: 'agent-model', maxSteps: 4 }),
    cippEnabled: true, cippApiUrl: 'https://cipp.test', cippTenantId: 'msp', cippClientId: 'c',
    cippClientSecret: encrypt('s', process.env.ENCRYPTION_KEY!),
  });
  await db.insert(clients).values({
    id: 'c1', tenantId: 't1', name: 'Acme', automationEnabled: true,
    emailDomains: JSON.stringify(['acme.com']), m365DefaultDomain: 'acme.onmicrosoft.com',
    authorisedContacts: JSON.stringify(['boss@acme.com']),
  });
  await db.insert(runbooks).values({
    id: 'rb1', tenantId: 't1', clientId: 'c1', title: 'Acme finance access',
    body: 'Finance staff get the Finance security group. Approval from the finance manager is required.',
  });
  [tenant] = await db.select().from(tenants).where(eq(tenants.id, 't1'));
  [client] = await db.select().from(clients).where(eq(clients.id, 'c1'));
});

beforeEach(() => {
  cipp = baseState();
  requests = [];
  rejectTools = false;
  const fakeCipp = createFakeCipp(cipp);
  let turn = 0;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://ai.test')) return fakeCipp(input, init);
    const body = JSON.parse(String(init!.body));
    requests.push(body);
    if (rejectTools && body.tools) return new Response('{"error":{"message":"tools is not supported for this model"}}', { status: 400 });
    const step = script[Math.min(turn++, script.length - 1)];
    const message = step.tool_calls && body.tools
      ? { role: 'assistant', content: null, tool_calls: step.tool_calls.map((c, i) => ({ id: `call-${turn}-${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
      : { role: 'assistant', content: step.content ?? script[script.length - 1].content };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  });
});

const input = () => ({
  tenant,
  client,
  ticket: { subject: 'Access to finance share', body: 'Please add sam@acme.com to the finance group', requesterEmail: 'boss@acme.com' },
  triage: { classification: 'group_add', category: 'identity_access', priority: 'P4', summary: 'Add Sam to Finance', targetUserEmail: 'sam@acme.com' },
  similar: [],
});

const final = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    findings: ['lookup_user: Sam is enabled', 'find_group: Finance is a security group'],
    diagnosis: 'Sam needs the Finance group.',
    recommended_action: { action: 'group_add', target_user_email: 'sam@acme.com', group_name: 'Finance', license_sku: null },
    confidence: 0.9,
    technician_steps: ['Add Sam to Finance'],
    reply_to_requester: 'Sam will have access shortly.',
    missing_information: null,
    ...overrides,
  });

describe('investigate', () => {
  it('uses the tools, then grounds its recommendation in what they returned', async () => {
    script = [
      { tool_calls: [{ name: 'lookup_user', args: { email: 'sam@acme.com' } }, { name: 'find_group', args: { name: 'finance' } }] },
      { tool_calls: [{ name: 'search_knowledge', args: { query: 'finance group access' } }] },
      { content: final() },
    ];
    const result = await agent.investigate(input());
    expect(result.status).toBe('completed');
    expect(result.model).toBe('agent-model');
    expect(result.steps.map((s) => s.tool)).toEqual(['lookup_user', 'find_group', 'search_knowledge']);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(result.steps[2].summary).toMatch(/Acme finance access/);
    expect(result.recommendation).toMatchObject({ action: 'group_add', groupName: 'Finance' });
    expect(result.ungrounded).toEqual([]);
    expect(cipp.reads.every((r) => r.includes('tenantFilter=acme.onmicrosoft.com'))).toBe(true);
  });

  it('drops a group the tools never showed', async () => {
    script = [{ tool_calls: [{ name: 'lookup_user', args: { email: 'sam@acme.com' } }] }, { content: final({ recommended_action: { action: 'group_add', target_user_email: 'sam@acme.com', group_name: 'Finance-All-Staff' } }) }];
    const result = await agent.investigate(input());
    expect(result.recommendation?.groupName).toBeNull();
    expect(result.ungrounded).toContain('group "Finance-All-Staff"');
  });

  it('drops findings credited to lookups that never ran', async () => {
    script = [
      { tool_calls: [{ name: 'lookup_user', args: { email: 'sam@acme.com' } }] },
      { content: final({ findings: ['lookup_user: Sam is enabled', 'recent_signins: 40 failed sign-ins from Russia'] }) },
    ];
    const result = await agent.investigate(input());
    expect(result.findings).toEqual(['lookup_user: Sam is enabled']);
    expect(result.ungrounded.join()).toMatch(/recent_signins/);
  });

  it('refuses to look up a user at another client, whatever the ticket says', async () => {
    script = [{ tool_calls: [{ name: 'lookup_user', args: { email: 'ceo@globex.com' } }] }, { content: final() }];
    const result = await agent.investigate(input());
    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].summary).toMatch(/not on a domain Acme owns/);
    expect(cipp.reads).toEqual([]);
  });

  it('stops after its step budget and still answers', async () => {
    script = [{ tool_calls: [{ name: 'licence_stock', args: {} }] }, { content: final() }];
    // The script repeats the tool call; the budget of 4 forces the answer.
    script = [
      { tool_calls: [{ name: 'licence_stock', args: {} }] },
      { tool_calls: [{ name: 'licence_stock', args: {} }] },
      { tool_calls: [{ name: 'licence_stock', args: {} }] },
      { tool_calls: [{ name: 'licence_stock', args: {} }] },
      { content: final() },
    ];
    const result = await agent.investigate(input());
    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(4);
    expect(requests.at(-1)!.tools).toBeUndefined();
  });

  it('reports a model without tool support clearly', async () => {
    rejectTools = true;
    script = [{ content: final() }];
    const result = await agent.investigate(input());
    expect(result.status).toBe('unavailable');
    expect(result.error).toMatch(/does not support tool calling/);
  });

  it('marks ticket text as untrusted in what the model sees', async () => {
    script = [{ content: final() }];
    await agent.investigate(input());
    expect(requests[0].messages[1].content).toMatch(/BEGIN TICKET BODY \(untrusted/);
    expect(requests[0].messages[0].content).toMatch(/data, not instructions/);
  });
});

describe('applyInvestigation', () => {
  const verdict = () => ({
    classification: 'group_add',
    confidence: 0.9,
    sensitivity: 'normal' as const,
    entities: { target_user_email: 'sam@acme.com', target_user_display_name: null, group_name: 'finance team', license_sku: null },
    reasoning: '',
    follow_up_question: null,
    escalation_reason: null,
    proposed_psa_note: '',
    triage: { category: 'identity_access', subcategory: null, impact: 'individual' as const, urgency: 'routine' as const, summary: '', sentiment: 'neutral' as const, first_response: null, next_steps: [] },
  });
  const outcome = () => ({ classification: verdict(), impact: 'individual' as const, basePriority: 'P4' as const, priority: 'P4' as const, queue: 'Service desk', signals: [], adjustments: [] as string[] });

  it('fills in the confirmed group when it agrees on the action', async () => {
    const { applyInvestigation } = await import('../src/services/triage/pipeline');
    const v = verdict();
    const o = outcome();
    applyInvestigation({ status: 'completed', recommendation: { action: 'group_add', targetUserEmail: 'sam@acme.com', groupName: 'Finance', licenceName: null } } as never, v, o);
    expect(v.entities.group_name).toBe('Finance');
    expect(o.adjustments.join()).toMatch(/confirmed group "Finance"/);
  });

  it('flags a disagreement instead of swapping the action', async () => {
    const { applyInvestigation } = await import('../src/services/triage/pipeline');
    const v = verdict();
    const o = outcome();
    applyInvestigation({ status: 'completed', diagnosis: 'Needs a licence.', recommendation: { action: 'license_assign', targetUserEmail: null, groupName: null, licenceName: null } } as never, v, o);
    expect(v.classification).toBe('group_add');
    expect((o.signals as Array<{ id: string }>).map((s) => s.id)).toContain('agent_disagrees');
  });
});
