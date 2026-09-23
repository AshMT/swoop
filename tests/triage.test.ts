import './setup-env';
import { describe, expect, it } from 'vitest';
import {
  atLeast,
  canonicaliseCategory,
  categoryForAction,
  normaliseImpact,
  normaliseUrgency,
  priorityFor,
  raisePriority,
} from '../src/domain/triage';
import { detectSignals } from '../src/services/triage/signals';
import { isWithinBusinessHours, readTriageSettings, DEFAULT_TRIAGE_SETTINGS } from '../src/services/triage/settings';
import { rankSimilar, tokenize } from '../src/services/triage/similarity';
import {
  assessTenancy,
  clientForDomain,
  domainOf,
  normaliseDomain,
  resolveClient,
} from '../src/services/triage/tenancy';
import { finaliseTriage } from '../src/services/triage/verdict';
import { parseClassification } from '../src/services/ai';
import type { AiClassification, Client } from '../src/types';

function client(overrides: Partial<Client>): Client {
  return {
    id: 'c1',
    tenantId: 't1',
    name: 'Acme',
    superopsCompanyId: '100',
    automationEnabled: true,
    contextNotes: null,
    systemPromptOverride: null,
    emailDomains: JSON.stringify(['acme.com']),
    m365TenantId: null,
    m365DefaultDomain: 'acme.onmicrosoft.com',
    vipEmails: null,
    createdAt: 0,
    ...overrides,
  };
}

const acme = client({});
const globex = client({ id: 'c2', name: 'Globex', superopsCompanyId: '200', emailDomains: JSON.stringify(['globex.com']), m365DefaultDomain: null });

function signals(text: string, extra: Partial<Parameters<typeof detectSignals>[0]> = {}) {
  return detectSignals({
    subject: text,
    body: '',
    requesterEmail: 'bob@acme.com',
    vipEmails: [],
    withinBusinessHours: true,
    recentFromRequester: 0,
    repeatThreshold: 3,
    ...extra,
  });
}

describe('priority matrix', () => {
  it('maps impact and urgency to a priority', () => {
    expect(priorityFor('organisation', 'blocking')).toBe('P1');
    expect(priorityFor('team', 'blocking')).toBe('P2');
    expect(priorityFor('individual', 'blocking')).toBe('P3');
    expect(priorityFor('individual', 'routine')).toBe('P4');
  });

  it('raises but never past P1', () => {
    expect(raisePriority('P3')).toBe('P2');
    expect(raisePriority('P1')).toBe('P1');
    expect(atLeast('P4', 'P2')).toBe('P2');
    expect(atLeast('P1', 'P2')).toBe('P1');
  });

  it('normalises model drift', () => {
    expect(normaliseImpact('Organization-wide')).toBe('organisation');
    expect(normaliseImpact('Department')).toBe('team');
    expect(normaliseImpact(undefined)).toBe('individual');
    expect(normaliseUrgency('Critical')).toBe('blocking');
    expect(normaliseUrgency('slow')).toBe('degraded');
    expect(normaliseUrgency('whenever')).toBe('routine');
  });

  it('canonicalises categories from labels and aliases', () => {
    expect(canonicaliseCategory('Email & Collaboration')).toBe('email_collab');
    expect(canonicaliseCategory('printer problem')).toBe('printing');
    expect(canonicaliseCategory('network')).toBe('network');
    expect(canonicaliseCategory('astrology')).toBeNull();
    expect(categoryForAction('mailbox_permission')).toBe('email_collab');
  });
});

describe('parseClassification triage fields', () => {
  const base = {
    classification: 'ESCALATE',
    confidence: 0.9,
    reasoning: 'Printer fault.',
    proposed_psa_note: 'Investigate the printer.',
  };

  it('reads a full triage', () => {
    const result = parseClassification(
      JSON.stringify({
        ...base,
        category: 'Printing & scanning',
        impact: 'team',
        urgency: 'degraded',
        summary: 'Printer offline.',
        sentiment: 'Frustrated',
        first_response: 'Looking now.',
        next_steps: ['Ping it', '  ', 42, 'Check the queue'],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.triage).toMatchObject({
      category: 'printing',
      impact: 'team',
      urgency: 'degraded',
      sentiment: 'frustrated',
      next_steps: ['Ping it', 'Check the queue'],
    });
  });

  it('fills defaults when a custom prompt omits the triage', () => {
    const result = parseClassification(JSON.stringify({ ...base, classification: 'group_add' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.triage.category).toBe('identity_access');
    expect(result.value.triage.summary).toBe('Printer fault.');
    expect(result.adjustments.join(' ')).toMatch(/no category/);
  });
});

describe('signals', () => {
  it('flags phishing and payment fraud', () => {
    expect(signals('I clicked a link in an email and entered my password').security).toBe(true);
    const bec = signals('Please update our bank details before paying the next invoice');
    expect(bec.security).toBe(true);
    expect(bec.signals.map((s) => s.id)).toContain('security_payment_fraud');
  });

  it('does not flag an ordinary request', () => {
    const result = signals('Can you add Sam to the marketing distribution list?');
    expect(result.security).toBe(false);
    expect(result.impactFloor).toBeNull();
  });

  it('detects organisation-wide outages', () => {
    expect(signals('Nobody in the office can get on the internet').impactFloor).toBe('organisation');
    expect(signals('The accounts team cannot print').impactFloor).toBe('team');
  });

  it('flags VIPs, out-of-hours and repeat requesters', () => {
    const result = signals('help', {
      vipEmails: ['bob@acme.com'],
      withinBusinessHours: false,
      recentFromRequester: 3,
    });
    const ids = result.signals.map((s) => s.id);
    expect(result.vipRequester).toBe(true);
    expect(ids).toEqual(expect.arrayContaining(['vip_requester', 'after_hours', 'repeat_requester']));
  });
});

describe('business hours', () => {
  const hours = { timezone: 'Australia/Sydney', days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };

  it('respects the tenant timezone', () => {
    // 2026-09-23 is a Wednesday. 00:00 UTC is 10:00 in Sydney.
    expect(isWithinBusinessHours(new Date('2026-09-23T00:00:00Z'), hours)).toBe(true);
    // 12:00 UTC is 22:00 in Sydney.
    expect(isWithinBusinessHours(new Date('2026-09-23T12:00:00Z'), hours)).toBe(false);
  });

  it('treats weekends as out of hours', () => {
    expect(isWithinBusinessHours(new Date('2026-09-26T00:00:00Z'), hours)).toBe(false);
  });

  it('never floods on-call for a bad timezone', () => {
    expect(isWithinBusinessHours(new Date(), { ...hours, timezone: 'Mars/Olympus' })).toBe(true);
  });

  it('falls back to defaults for unreadable settings', () => {
    expect(readTriageSettings('{not json')).toEqual(DEFAULT_TRIAGE_SETTINGS);
    expect(readTriageSettings(JSON.stringify({ clusterThreshold: 5 })).clusterThreshold).toBe(5);
  });
});

describe('similarity', () => {
  it('tokenises without stopwords and with light stemming', () => {
    expect(tokenize('Hi team, the printers are not printing!')).toEqual(['print', 'print']);
  });

  it('ranks the same problem above an unrelated one', () => {
    const ranked = rankSimilar({ subject: 'Outlook keeps asking for password', body: '' }, [
      { id: 'a', subject: 'Printer offline upstairs', body: '' },
      { id: 'b', subject: 'Outlook asking for my password again', body: '' },
      { id: 'c', subject: 'New starter Monday', body: '' },
    ]);
    expect(ranked[0].doc.id).toBe('b');
    expect(ranked[0].score).toBeGreaterThan(0.5);
    expect(ranked.find((r) => r.doc.id === 'a')).toBeUndefined();
  });
});

describe('tenancy', () => {
  it('parses and normalises domains', () => {
    expect(domainOf('Bob <bob@Mail.Acme.com>')).toBe('mail.acme.com');
    expect(normaliseDomain('https://acme.com/')).toBe('acme.com');
    expect(normaliseDomain('@acme.com')).toBe('acme.com');
    expect(normaliseDomain('not a domain')).toBeNull();
  });

  it('finds the owning client, preferring the most specific domain', () => {
    const sub = client({ id: 'c3', name: 'Acme Labs', emailDomains: JSON.stringify(['labs.acme.com']) });
    expect(clientForDomain('labs.acme.com', [acme, sub])?.id).toBe('c3');
    expect(clientForDomain('mail.acme.com', [acme, sub])?.id).toBe('c1');
  });

  it('matches a ticket by requester domain when the company is unknown', () => {
    const match = resolveClient(
      { ticketId: '1', displayId: null, subject: '', body: '', status: null, priority: null, createdAt: null, clientId: null, clientName: null, requesterEmail: 'jo@globex.com', requesterName: null },
      [acme, globex],
    );
    expect(match).toEqual({ client: globex, method: 'email_domain' });
  });

  it('flags a request for another client’s user', () => {
    const t = assessTenancy({
      client: acme,
      matchMethod: 'company_id',
      requesterEmail: 'bob@acme.com',
      targetEmail: 'ceo@globex.com',
      allClients: [acme, globex],
    });
    expect(t.flags).toContain('target_other_client');
    expect(t.crossTenant).toBe(true);
    expect(t.targetClient?.name).toBe('Globex');
  });

  it('flags a personal requester address without calling it cross-tenant', () => {
    const t = assessTenancy({
      client: acme,
      matchMethod: 'company_id',
      requesterEmail: 'bob.smith1974@gmail.com',
      targetEmail: 'bob@acme.com',
      allClients: [acme, globex],
    });
    expect(t.flags).toEqual(['requester_free_mail']);
    expect(t.crossTenant).toBe(false);
  });

  it('uses the M365 default domain as an owned domain', () => {
    const t = assessTenancy({
      client: acme,
      matchMethod: 'company_id',
      requesterEmail: 'admin@acme.onmicrosoft.com',
      targetEmail: null,
      allClients: [acme, globex],
    });
    expect(t.flags).toEqual([]);
  });
});

describe('finaliseTriage', () => {
  const settings = DEFAULT_TRIAGE_SETTINGS;
  const history = { similar: [], duplicateOf: null, references: [], recentFromRequester: 0 };
  const base: AiClassification = {
    classification: 'password_reset',
    confidence: 0.95,
    sensitivity: 'normal',
    entities: { target_user_email: 'sam@acme.com', target_user_display_name: null, group_name: null, license_sku: null },
    reasoning: 'Reset.',
    follow_up_question: null,
    escalation_reason: null,
    proposed_psa_note: 'Reset it.',
    triage: {
      category: 'identity_access',
      subcategory: null,
      impact: 'individual',
      urgency: 'routine',
      summary: 'Reset.',
      sentiment: 'neutral',
      first_response: null,
      next_steps: [],
    },
  };
  const tenancyFor = (targetEmail: string | null, requesterEmail = 'bob@acme.com') =>
    assessTenancy({ client: acme, matchMethod: 'company_id', requesterEmail, targetEmail, allClients: [acme, globex] });

  it('computes priority and queue from the matrix and routing', () => {
    const out = finaliseTriage({ classification: base, signals: signals('reset please'), tenancy: tenancyFor('sam@acme.com'), history, cluster: null, settings });
    expect(out.priority).toBe('P4');
    expect(out.queue).toBe('Service desk');
    expect(out.classification.classification).toBe('password_reset');
  });

  it('escalates a cross-client request and routes it to Security', () => {
    const out = finaliseTriage({ classification: base, signals: signals('reset please'), tenancy: tenancyFor('ceo@globex.com'), history, cluster: null, settings });
    expect(out.classification.classification).toBe('ESCALATE');
    expect(out.classification.sensitivity).toBe('high');
    expect(out.priority).toBe('P2');
    expect(out.queue).toBe('Security');
    expect(out.signals.map((s) => s.id)).toContain('tenancy_target_other_client');
  });

  it('never lets a keyword lower what the model said', () => {
    const urgent = { ...base, triage: { ...base.triage, impact: 'organisation' as const, urgency: 'blocking' as const } };
    const out = finaliseTriage({ classification: urgent, signals: signals('The accounts team cannot print'), tenancy: tenancyFor('sam@acme.com'), history, cluster: null, settings });
    expect(out.impact).toBe('organisation');
    expect(out.priority).toBe('P1');
  });

  it('bumps security tickets and VIPs', () => {
    const phish = finaliseTriage({ classification: base, signals: signals('I clicked a link and entered my password'), tenancy: tenancyFor('sam@acme.com'), history, cluster: null, settings });
    expect(phish.classification.triage.category).toBe('security');
    expect(phish.priority).toBe('P2');

    const vip = finaliseTriage({ classification: base, signals: signals('reset', { vipEmails: ['bob@acme.com'] }), tenancy: tenancyFor('sam@acme.com'), history, cluster: null, settings });
    expect(vip.priority).toBe('P3');
  });

  it('routes an urgent out-of-hours ticket to on-call', () => {
    const out = finaliseTriage({
      classification: base,
      signals: signals('I clicked a link', { withinBusinessHours: false }),
      tenancy: tenancyFor('sam@acme.com'),
      history,
      cluster: null,
      settings,
    });
    expect(out.queue).toBe('On-call');
  });

  it('raises a clustered ticket to at least P2', () => {
    const out = finaliseTriage({
      classification: base,
      signals: signals('Outlook not working'),
      tenancy: tenancyFor('sam@acme.com'),
      history,
      cluster: { clusterId: 'x', isNew: true, size: 4, clientCount: 2, label: 'Outlook', crossClient: true },
      settings,
    });
    expect(out.priority).toBe('P2');
    expect(out.signals.find((s) => s.id === 'incident_cluster')?.label).toBe('Multi-client incident');
  });
});
