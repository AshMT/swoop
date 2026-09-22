import './setup-env';
import { describe, expect, it } from 'vitest';
import { applyPolicy, parseClassification, normaliseBaseUrl } from '../src/services/ai';
import { canonicaliseAction, isKnownAction } from '../src/domain/classifications';
import type { AiClassification } from '../src/types';

function response(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    classification: 'password_reset',
    confidence: 0.9,
    sensitivity: 'normal',
    entities: {
      target_user_email: 'sarah@acme.com',
      target_user_display_name: 'Sarah',
      group_name: null,
      license_sku: null,
    },
    reasoning: 'Explicit password reset request.',
    follow_up_question: null,
    escalation_reason: null,
    proposed_psa_note: 'Reset the password for sarah@acme.com.',
    ...overrides,
  });
}

describe('canonicaliseAction', () => {
  it('accepts the canonical id', () => {
    expect(canonicaliseAction('password_reset')).toBe('password_reset');
  });

  it('normalises case, spaces and hyphens', () => {
    expect(canonicaliseAction('Password Reset')).toBe('password_reset');
    expect(canonicaliseAction('password-reset')).toBe('password_reset');
    expect(canonicaliseAction('  PASSWORD_RESET  ')).toBe('password_reset');
  });

  it('normalises a plural', () => {
    expect(canonicaliseAction('password_resets')).toBe('password_reset');
  });

  it('preserves the uppercase terminal labels', () => {
    expect(canonicaliseAction('escalate')).toBe('ESCALATE');
    expect(canonicaliseAction('Follow Up')).toBe('FOLLOW_UP');
  });

  it('returns null for something genuinely unknown', () => {
    expect(canonicaliseAction('order_a_pizza')).toBeNull();
    expect(canonicaliseAction('')).toBeNull();
    expect(canonicaliseAction(null)).toBeNull();
  });
});

describe('parseClassification', () => {
  it('parses a well-formed response', () => {
    const result = parseClassification(response());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.classification).toBe('password_reset');
    expect(result.value.confidence).toBe(0.9);
    expect(result.value.entities.target_user_email).toBe('sarah@acme.com');
    expect(result.adjustments).toEqual([]);
  });

  it('rescales a percentage confidence to 0-1', () => {
    const result = parseClassification(response({ confidence: 85 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.confidence).toBeCloseTo(0.85);
    expect(result.adjustments.join(' ')).toMatch(/percentage/i);
  });

  it('clamps an out-of-range confidence', () => {
    const result = parseClassification(response({ confidence: -5 }));
    expect(result.ok && result.value.confidence).toBe(0);
  });

  it('escalates an unknown classification rather than storing it', () => {
    const result = parseClassification(response({ classification: 'reboot_the_server' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.classification).toBe('ESCALATE');
    expect(result.adjustments.join(' ')).toMatch(/unknown/i);
  });

  it('normalises a drifted label and records the adjustment', () => {
    const result = parseClassification(response({ classification: 'Group Add' }));
    expect(result.ok && result.value.classification).toBe('group_add');
  });

  // A FOLLOW_UP with no question would post a note asking nothing at all.
  it('downgrades FOLLOW_UP with no question to ESCALATE', () => {
    const result = parseClassification(
      response({ classification: 'FOLLOW_UP', follow_up_question: null }),
    );
    expect(result.ok && result.value.classification).toBe('ESCALATE');
  });

  it('keeps a FOLLOW_UP that does have a question', () => {
    const result = parseClassification(
      response({ classification: 'FOLLOW_UP', follow_up_question: 'Which mailbox?' }),
    );
    expect(result.ok && result.value.classification).toBe('FOLLOW_UP');
    expect(result.ok && result.value.follow_up_question).toBe('Which mailbox?');
  });

  it('treats string stand-ins for null as null', () => {
    const result = parseClassification(
      response({ entities: { target_user_email: 'N/A', group_name: 'none', license_sku: 'unknown' } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities.target_user_email).toBeNull();
    expect(result.value.entities.group_name).toBeNull();
    expect(result.value.entities.license_sku).toBeNull();
  });

  // The prompt says never to invent an address; models do it anyway.
  it('discards placeholder email addresses', () => {
    for (const email of ['user@example.com', 'firstname.lastname@company.com', 'username@domain.com']) {
      const result = parseClassification(response({ entities: { target_user_email: email } }));
      expect(result.ok && result.value.entities.target_user_email, email).toBeNull();
    }
  });

  it('extracts an address embedded in surrounding text', () => {
    const result = parseClassification(
      response({ entities: { target_user_email: 'the user <Sarah.Jones@Acme.com>' } }),
    );
    expect(result.ok && result.value.entities.target_user_email).toBe('sarah.jones@acme.com');
  });

  it('generates a note when the model omits proposed_psa_note', () => {
    const result = parseClassification(response({ proposed_psa_note: null }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.proposed_psa_note).toBeTruthy();
    expect(result.adjustments.join(' ')).toMatch(/omitted/i);
  });

  it('fails cleanly when a required field is missing', () => {
    const result = parseClassification('{"confidence":0.9}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/classification/);
  });

  it('fails cleanly on unparseable output', () => {
    const result = parseClassification('I am sorry, I cannot help with that.');
    expect(result.ok).toBe(false);
  });

  it('only keeps escalation_reason on terminal classifications', () => {
    const result = parseClassification(response({ escalation_reason: 'should be dropped' }));
    expect(result.ok && result.value.escalation_reason).toBeNull();
  });
});

describe('applyPolicy', () => {
  const base: AiClassification = {
    classification: 'password_reset',
    confidence: 0.6,
    sensitivity: 'normal',
    entities: { target_user_email: null, target_user_display_name: null, group_name: null, license_sku: null },
    reasoning: 'r',
    follow_up_question: null,
    escalation_reason: null,
    proposed_psa_note: 'n',
  };

  it('escalates below the threshold', () => {
    const { classification, adjustments } = applyPolicy(base, { confidenceThreshold: 0.75 });
    expect(classification.classification).toBe('ESCALATE');
    expect(classification.escalation_reason).toMatch(/threshold/);
    expect(adjustments).toHaveLength(1);
  });

  it('leaves a confident classification alone', () => {
    const { classification, adjustments } = applyPolicy(
      { ...base, confidence: 0.95 },
      { confidenceThreshold: 0.75 },
    );
    expect(classification.classification).toBe('password_reset');
    expect(adjustments).toHaveLength(0);
  });

  it('honours a lowered threshold', () => {
    const { classification } = applyPolicy(base, { confidenceThreshold: 0.5 });
    expect(classification.classification).toBe('password_reset');
  });

  // A low-confidence FOLLOW_UP is still a useful question to ask.
  it('does not re-escalate an already-terminal classification', () => {
    const { classification } = applyPolicy(
      { ...base, classification: 'FOLLOW_UP', confidence: 0.3, follow_up_question: 'Which user?' },
      { confidenceThreshold: 0.75 },
    );
    expect(classification.classification).toBe('FOLLOW_UP');
  });

  it('does not mutate its input', () => {
    const input = { ...base };
    applyPolicy(input, { confidenceThreshold: 0.75 });
    expect(input.classification).toBe('password_reset');
  });

  it('skips grounding when no source text is supplied', () => {
    const withEmail = {
      ...base,
      confidence: 0.95,
      entities: { ...base.entities, target_user_email: 'sarah@acme.com' },
    };
    const { classification } = applyPolicy(withEmail, { confidenceThreshold: 0.75 });
    expect(classification.entities.target_user_email).toBe('sarah@acme.com');
  });
});

/**
 * The prompt tells the model never to invent an address, but it also carries
 * worked examples, and a small model can copy an address out of one of them.
 * An address that was never in the ticket names a real user who did not ask
 * for anything, so it is worse than no address at all.
 */
describe('entity grounding', () => {
  const confident: AiClassification = {
    classification: 'password_reset',
    confidence: 0.95,
    sensitivity: 'normal',
    entities: {
      target_user_email: 'sarah.jones@acme.com',
      target_user_display_name: 'Sarah Jones',
      group_name: null,
      license_sku: null,
    },
    reasoning: 'r',
    follow_up_question: null,
    escalation_reason: null,
    proposed_psa_note: 'n',
  };

  it('keeps an address that appears in the ticket', () => {
    const { classification, adjustments } = applyPolicy(confident, {
      confidenceThreshold: 0.75,
      sourceText: 'Please reset the password for sarah.jones@acme.com, she is locked out.',
    });
    expect(classification.entities.target_user_email).toBe('sarah.jones@acme.com');
    expect(adjustments).toHaveLength(0);
  });

  it('matches case-insensitively', () => {
    const { classification } = applyPolicy(confident, {
      confidenceThreshold: 0.75,
      sourceText: 'Reset for Sarah.Jones@Acme.com please',
    });
    expect(classification.entities.target_user_email).toBe('sarah.jones@acme.com');
  });

  it('discards an address the ticket never mentioned', () => {
    const { classification, adjustments } = applyPolicy(confident, {
      confidenceThreshold: 0.75,
      sourceText: 'We have someone new starting Monday, can you get them set up?',
    });
    expect(classification.entities.target_user_email).toBeNull();
    expect(adjustments.join(' ')).toMatch(/does not appear anywhere in the ticket/);
  });

  it('asks the requester rather than proposing an action with no target', () => {
    const { classification } = applyPolicy(confident, {
      confidenceThreshold: 0.75,
      sourceText: 'Someone new is starting Monday.',
    });
    expect(classification.classification).toBe('FOLLOW_UP');
    expect(classification.follow_up_question).toMatch(/email address/i);
  });

  it('leaves an ESCALATE as an escalation', () => {
    const { classification } = applyPolicy(
      { ...confident, classification: 'ESCALATE' },
      { confidenceThreshold: 0.75, sourceText: 'Unrelated ticket text.' },
    );
    expect(classification.classification).toBe('ESCALATE');
    expect(classification.entities.target_user_email).toBeNull();
  });

  it('matches an address found only in the requester field', () => {
    const { classification } = applyPolicy(
      {
        ...confident,
        entities: { ...confident.entities, target_user_email: 'dan@acme.com' },
      },
      { confidenceThreshold: 0.75, sourceText: 'Reset my password please\n\ndan@acme.com' },
    );
    expect(classification.entities.target_user_email).toBe('dan@acme.com');
  });
});

describe('normaliseBaseUrl', () => {
  it('appends /v1 to a bare host, so operators can paste an Ollama URL', () => {
    expect(normaliseBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
  });

  it('leaves an existing /v1 alone and strips trailing slashes', () => {
    expect(normaliseBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(normaliseBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
  });

  it('does not double up on a versioned path', () => {
    expect(normaliseBaseUrl('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/openai/v1');
  });

  it('leaves an Azure-style openai path alone', () => {
    expect(normaliseBaseUrl('https://x.openai.azure.com/openai')).toBe('https://x.openai.azure.com/openai');
  });

  it('falls back for an empty value', () => {
    expect(normaliseBaseUrl('   ')).toBe('http://localhost:11434/v1');
  });
});

describe('isKnownAction', () => {
  it('recognises the canonical set', () => {
    expect(isKnownAction('mfa_reset')).toBe(true);
    expect(isKnownAction('ESCALATE')).toBe(true);
    expect(isKnownAction('nope')).toBe(false);
  });
});
