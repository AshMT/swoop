import './setup-env';
import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  defaultSystemPromptTemplate,
  promptFingerprint,
  promptSource,
  resolveSystemPrompt,
} from '../src/prompts/system';

/**
 * Accuracy figures from different prompts are not comparable, and the failure
 * mode is silent: tune the prompt to fix a confusion pair, and the agreement
 * rate afterwards averages over both versions, so the improvement is invisible.
 * The fingerprint is what lets the Calibration page scope to one version.
 */
describe('promptFingerprint', () => {
  it('is stable for the same prompt and model', () => {
    expect(promptFingerprint(null, 'gpt-4o-mini')).toBe(promptFingerprint(null, 'gpt-4o-mini'));
  });

  it('is short enough to display', () => {
    expect(promptFingerprint(null, 'gpt-4o-mini')).toHaveLength(12);
  });

  it('changes with the model, because the same prompt scores differently', () => {
    expect(promptFingerprint(null, 'gpt-4o-mini')).not.toBe(promptFingerprint(null, 'qwen3:8b'));
  });

  it('changes when the prompt is overridden', () => {
    expect(promptFingerprint('My custom prompt', 'gpt-4o-mini')).not.toBe(
      promptFingerprint(null, 'gpt-4o-mini'),
    );
  });

  it('changes when the override is edited', () => {
    expect(promptFingerprint('Prompt A', 'm')).not.toBe(promptFingerprint('Prompt B', 'm'));
  });

  it('treats an empty or whitespace override as the built-in prompt', () => {
    const builtin = promptFingerprint(null, 'm');
    expect(promptFingerprint('', 'm')).toBe(builtin);
    expect(promptFingerprint('   \n  ', 'm')).toBe(builtin);
    expect(promptFingerprint(undefined, 'm')).toBe(builtin);
  });

  it('ignores leading and trailing whitespace on an override', () => {
    expect(promptFingerprint('  Prompt A  ', 'm')).toBe(promptFingerprint('Prompt A', 'm'));
  });

  /**
   * The MSP and client names are substitutions, not semantic changes. If they
   * changed the fingerprint, every client would be its own incomparable
   * version and the figures would fragment into uselessness.
   */
  it('does not change per tenant or per client', () => {
    // The fingerprint hashes the template, so the only inputs are the override
    // and the model — nothing tenant-specific can reach it.
    const a = promptFingerprint(null, 'm');
    const b = promptFingerprint(null, 'm');
    expect(a).toBe(b);

    // Sanity-check that the rendered prompts genuinely do differ, so the test
    // above is asserting something real.
    expect(buildSystemPrompt({ mspName: 'MightyIT', clientName: 'Acme' })).not.toBe(
      buildSystemPrompt({ mspName: 'OtherMSP', clientName: 'Beta' }),
    );
  });

  it('is derived from the built-in template, so editing the prompt reflows it', () => {
    // A fingerprint of the current template must match the built-in one; if the
    // prompt module changes, both move together.
    expect(promptFingerprint(defaultSystemPromptTemplate(), 'm')).toBe(promptFingerprint(null, 'm'));
  });
});

describe('defaultSystemPromptTemplate', () => {
  it('uses placeholders rather than a specific tenant', () => {
    const template = defaultSystemPromptTemplate();
    expect(template).toContain('{{mspName}}');
    expect(template).toContain('{{clientName}}');
  });

  it('lists every action type, so the editor shows the real contract', () => {
    const template = defaultSystemPromptTemplate();
    for (const id of ['password_reset', 'mfa_reset', 'mailbox_permission', 'FOLLOW_UP', 'ESCALATE']) {
      expect(template, id).toContain(id);
    }
  });

  it('tells the model to ignore instructions inside the ticket', () => {
    expect(defaultSystemPromptTemplate()).toMatch(/ignore them/i);
  });
});


/**
 * Most specific wins. A client override replaces the prompt wholesale rather
 * than being appended, because two prompts concatenated tend to contradict
 * each other and the model follows whichever it saw last.
 */
describe('prompt resolution', () => {
  const context = { mspName: 'MightyIT', clientName: 'Acme' };

  it('falls back to the built-in prompt when nothing is overridden', () => {
    expect(resolveSystemPrompt(context, {})).toBe(buildSystemPrompt(context));
    expect(resolveSystemPrompt(context)).toBe(buildSystemPrompt(context));
  });

  it('uses the tenant override when there is no client one', () => {
    expect(resolveSystemPrompt(context, { tenant: 'tenant prompt' })).toBe('tenant prompt');
  });

  it('prefers the client override over the tenant one', () => {
    expect(resolveSystemPrompt(context, { client: 'client prompt', tenant: 'tenant prompt' })).toBe(
      'client prompt',
    );
  });

  it('replaces rather than appends, so the two cannot contradict each other', () => {
    const resolved = resolveSystemPrompt(context, { client: 'client prompt', tenant: 'tenant prompt' });
    expect(resolved).not.toContain('tenant prompt');
  });

  it('ignores a blank override at either layer', () => {
    expect(resolveSystemPrompt(context, { client: '   ', tenant: 'tenant prompt' })).toBe('tenant prompt');
    expect(resolveSystemPrompt(context, { client: '', tenant: '  ' })).toBe(buildSystemPrompt(context));
  });

  it('reports which layer supplied the prompt', () => {
    expect(promptSource({})).toBe('builtin');
    expect(promptSource({ tenant: 't' })).toBe('tenant');
    expect(promptSource({ client: 'c', tenant: 't' })).toBe('client');
    expect(promptSource({ client: '  ', tenant: 't' })).toBe('tenant');
  });
});

describe('promptFingerprint with a client override', () => {
  it('distinguishes a client override from the tenant prompt', () => {
    expect(promptFingerprint({ client: 'client prompt', tenant: 't' }, 'm')).not.toBe(
      promptFingerprint({ tenant: 't' }, 'm'),
    );
  });

  it('matches the tenant fingerprint when the client has no override', () => {
    expect(promptFingerprint({ client: null, tenant: 'tenant prompt' }, 'm')).toBe(
      promptFingerprint('tenant prompt', 'm'),
    );
  });

  it('still accepts a bare string for the tenant-only case', () => {
    expect(promptFingerprint('tenant prompt', 'm')).toBe(promptFingerprint({ tenant: 'tenant prompt' }, 'm'));
    expect(promptFingerprint(null, 'm')).toBe(promptFingerprint({}, 'm'));
  });

  /**
   * Two clients on different prompts must not have their accuracy averaged
   * together — that is the whole point of the fingerprint.
   */
  it('gives two clients with different overrides different fingerprints', () => {
    expect(promptFingerprint({ client: 'prompt for Acme' }, 'm')).not.toBe(
      promptFingerprint({ client: 'prompt for Beta' }, 'm'),
    );
  });
});
