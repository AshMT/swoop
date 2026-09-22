import './setup-env';
import { describe, expect, it } from 'vitest';
import { matchTicketToClient } from '../src/services/matching';
import { htmlToText, truncateForPrompt } from '../src/lib/html';
import { formatProposalNote } from '../src/services/note-format';
import type { Client } from '../src/types';
import type { PsaTicket } from '../src/services/psa/interface';

function client(overrides: Partial<Client>): Client {
  return {
    id: 'c1',
    tenantId: 't1',
    name: 'Acme Corp',
    superopsCompanyId: null,
    automationEnabled: true,
    contextNotes: null,
    createdAt: 0,
    ...overrides,
  } as Client;
}

function ticket(overrides: Partial<PsaTicket>): PsaTicket {
  return {
    ticketId: 'T-1',
    displayId: '1',
    subject: 's',
    body: '',
    status: null,
    priority: null,
    createdAt: null,
    clientId: null,
    clientName: null,
    requesterEmail: null,
    requesterName: null,
    ...overrides,
  };
}

describe('matchTicketToClient', () => {
  // The bug this replaces: superopsCompanyId was compared against the ticket's
  // client NAME, so a client configured by ID never matched and the allowlist
  // silently discarded every one of its tickets.
  it('matches on the SuperOps company ID', () => {
    const acme = client({ id: 'c1', superopsCompanyId: 'acct-9' });
    const other = client({ id: 'c2', name: 'Other', superopsCompanyId: 'acct-1' });
    expect(matchTicketToClient(ticket({ clientId: 'acct-9' }), [other, acme])?.id).toBe('c1');
  });

  it('matches on the client name when no ID is configured', () => {
    const acme = client({ id: 'c1', name: 'Acme Corp' });
    expect(matchTicketToClient(ticket({ clientName: 'Acme Corp' }), [acme])?.id).toBe('c1');
  });

  it('matches names case-insensitively and ignoring surrounding whitespace', () => {
    const acme = client({ id: 'c1', name: 'Acme Corp' });
    expect(matchTicketToClient(ticket({ clientName: '  acme corp ' }), [acme])?.id).toBe('c1');
  });

  it('prefers the ID match when the name would match a different client', () => {
    const byId = client({ id: 'c1', name: 'Renamed Ltd', superopsCompanyId: 'acct-9' });
    const byName = client({ id: 'c2', name: 'Acme Corp' });
    const result = matchTicketToClient(ticket({ clientId: 'acct-9', clientName: 'Acme Corp' }), [byName, byId]);
    expect(result?.id).toBe('c1');
  });

  // Operators paste the company name into the ID field often enough that
  // falling back on it is worth doing.
  it('matches a name against a company ID field holding that name', () => {
    const acme = client({ id: 'c1', name: 'Different', superopsCompanyId: 'Acme Corp' });
    expect(matchTicketToClient(ticket({ clientName: 'Acme Corp' }), [acme])?.id).toBe('c1');
  });

  it('returns null when nothing matches — the allowlist holds', () => {
    const acme = client({ id: 'c1', name: 'Acme Corp', superopsCompanyId: 'acct-9' });
    expect(matchTicketToClient(ticket({ clientName: 'Someone Else' }), [acme])).toBeNull();
    expect(matchTicketToClient(ticket({ clientId: 'acct-000' }), [acme])).toBeNull();
    expect(matchTicketToClient(ticket({}), [acme])).toBeNull();
  });

  it('returns null when there are no enabled clients at all', () => {
    expect(matchTicketToClient(ticket({ clientName: 'Acme Corp' }), [])).toBeNull();
  });

  it('does not match on an empty string', () => {
    const blank = client({ id: 'c1', name: 'x', superopsCompanyId: '' });
    expect(matchTicketToClient(ticket({ clientId: '', clientName: '' }), [blank])).toBeNull();
  });
});

describe('htmlToText', () => {
  it('strips tags and keeps the words', () => {
    expect(htmlToText('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('preserves paragraph breaks as a blank line', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo');
  });

  it('turns <br> into a single line break', () => {
    expect(htmlToText('Line one<br>Line two')).toBe('Line one\nLine two');
  });

  it('drops script and style content entirely', () => {
    expect(htmlToText('<style>p{color:red}</style><p>Text</p><script>alert(1)</script>')).toBe('Text');
  });

  it('decodes common entities', () => {
    expect(htmlToText('Tom&nbsp;&amp;&nbsp;Jerry &lt;tag&gt; &quot;quoted&quot;')).toBe(
      'Tom & Jerry <tag> "quoted"',
    );
  });

  it('decodes numeric entities', () => {
    expect(htmlToText('&#65;&#66;&#x43;')).toBe('ABC');
  });

  it('collapses runaway whitespace from Outlook-style markup', () => {
    // Three or more consecutive breaks collapse to one blank line.
    expect(htmlToText('<div>\n\n  A  \n</div>\n\n\n<div>B</div>')).toBe('A\n\nB');
  });

  it('handles empty and null input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(null)).toBe('');
    expect(htmlToText(undefined)).toBe('');
  });

  it('leaves plain text untouched', () => {
    expect(htmlToText('Just plain text, no markup.')).toBe('Just plain text, no markup.');
  });
});

describe('truncateForPrompt', () => {
  it('leaves short text alone', () => {
    expect(truncateForPrompt('short')).toBe('short');
  });

  it('keeps the head and tail of long text', () => {
    const long = `START${'x'.repeat(10_000)}END`;
    const result = truncateForPrompt(long, 1000);
    expect(result.startsWith('START')).toBe(true);
    expect(result.endsWith('END')).toBe(true);
    expect(result).toContain('characters omitted');
    expect(result.length).toBeLessThan(1200);
  });
});

describe('formatProposalNote', () => {
  const base = {
    classification: 'password_reset',
    confidence: 0.92,
    sensitivity: 'normal' as const,
    entities: {
      target_user_email: 'sarah@acme.com',
      target_user_display_name: 'Sarah',
      group_name: null,
      license_sku: null,
    },
    reasoning: 'Explicit request.',
    follow_up_question: null,
    escalation_reason: null,
    proposed_psa_note: 'Reset the password.',
  };

  it('states the action, confidence and that nothing was done', () => {
    const note = formatProposalNote(base, { mspName: 'MightyIT' });
    expect(note).toContain('MightyIT');
    expect(note).toContain('Password reset');
    expect(note).toContain('92%');
    expect(note).toContain('sarah@acme.com');
    expect(note).toMatch(/no action has been taken/i);
  });

  it('leads with the question for a FOLLOW_UP', () => {
    const note = formatProposalNote(
      { ...base, classification: 'FOLLOW_UP', follow_up_question: 'Which mailbox?' },
      { mspName: 'MightyIT' },
    );
    expect(note).toContain('Which mailbox?');
    expect(note).toMatch(/more information needed/i);
  });

  it('states the escalation reason', () => {
    const note = formatProposalNote(
      { ...base, classification: 'ESCALATE', escalation_reason: 'Out of scope' },
      { mspName: 'MightyIT' },
    );
    expect(note).toMatch(/escalate to a human/i);
    expect(note).toContain('Out of scope');
  });

  it('calls out high sensitivity as an explicit approval requirement', () => {
    const note = formatProposalNote({ ...base, sensitivity: 'high' }, { mspName: 'MightyIT' });
    expect(note).toMatch(/approval/i);
    expect(note).toMatch(/regardless of confidence/i);
  });

  it('says so when running in preview mode', () => {
    const note = formatProposalNote(base, { mspName: 'MightyIT', dryRun: true });
    expect(note).toMatch(/read-only preview mode/i);
  });

  it('records any corrections applied to the model output', () => {
    const note = formatProposalNote(base, {
      mspName: 'MightyIT',
      adjustments: ['Confidence 0.60 is below the 0.75 threshold'],
    });
    expect(note).toContain('below the 0.75 threshold');
  });
});

/**
 * A classification whose note failed to post has already cost an AI call, so it
 * is retried by note attempt count rather than by re-running the classifier.
 * These assert the boundary the poller's retry query uses.
 */
describe('note delivery retry window', () => {
  const MAX_NOTE_ATTEMPTS = 5;

  /** Mirrors the `status = 'note_failed' AND note_attempts <= MAX - 1` filter. */
  const isRetryable = (status: string, attempts: number) =>
    status === 'note_failed' && attempts <= MAX_NOTE_ATTEMPTS - 1;

  it('retries a freshly failed note', () => {
    expect(isRetryable('note_failed', 1)).toBe(true);
  });

  it('keeps retrying up to the limit', () => {
    expect(isRetryable('note_failed', 4)).toBe(true);
  });

  it('stops at the limit rather than hammering the PSA forever', () => {
    expect(isRetryable('note_failed', 5)).toBe(false);
    expect(isRetryable('note_failed', 9)).toBe(false);
  });

  it('never retries a note that already landed', () => {
    expect(isRetryable('classified', 1)).toBe(false);
  });

  it('never retries an AI failure — there is no note to post', () => {
    expect(isRetryable('ai_failed', 1)).toBe(false);
  });
});
