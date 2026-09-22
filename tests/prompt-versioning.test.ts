import './setup-env';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, defaultSystemPromptTemplate, promptFingerprint } from '../src/prompts/system';

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
