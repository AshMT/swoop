import './setup-env';
import { describe, expect, it } from 'vitest';
import { PsaError, mapPsaError } from '../src/services/psa/superops';

const ENDPOINT = 'https://api.superops.ai/msp';
const SUBDOMAIN = 'mightyit';

function map(err: unknown): PsaError {
  return mapPsaError(err, ENDPOINT, SUBDOMAIN);
}

describe('mapPsaError', () => {
  it('passes a PsaError through unchanged', () => {
    const original = new PsaError('already mapped', { retryable: false });
    expect(map(original)).toBe(original);
  });

  it('explains a 401 and does not retry it', () => {
    const mapped = map({ response: { status: 401 } });
    expect(mapped.message).toMatch(/rejected the API token/i);
    expect(mapped.message).toContain(SUBDOMAIN);
    expect(mapped.retryable).toBe(false);
  });

  it('points a 404 at the data centre setting', () => {
    const mapped = map({ response: { status: 404 } });
    expect(mapped.message).toMatch(/data centre/i);
    expect(mapped.retryable).toBe(false);
  });

  it('treats a 429 as retryable', () => {
    expect(map({ response: { status: 429 } }).retryable).toBe(true);
  });

  it('treats a 5xx as retryable', () => {
    const mapped = map({ response: { status: 503 } });
    expect(mapped.message).toContain('503');
    expect(mapped.retryable).toBe(true);
  });

  /**
   * graphql-request stringifies the whole request into error.message. Echoing
   * that raw is what made the previous failures unreadable: the operator saw
   * their own introspection query instead of a cause.
   */
  it('never echoes the request query back to the operator', () => {
    const raw = new Error(
      'GraphQL Error (Code: 400): {"response":{"error":"","status":400,"headers":{}},"request":{"query":"\\n fragment TypeRef on __Type { kind name }\\n query SwoopProbeRoots { __schema { queryType { fields { name } } } }"}}',
    );
    const mapped = map(raw);
    expect(mapped.message).not.toContain('SwoopProbeRoots');
    expect(mapped.message).not.toContain('fragment TypeRef');
    expect(mapped.message).not.toContain('__schema');
  });

  it('turns a bare 400 into an actionable message', () => {
    const raw = new Error(
      'GraphQL Error (Code: 400): {"response":{"error":"","status":400},"request":{"query":"query X { y }"}}',
    );
    const mapped = map(raw);
    expect(mapped.message).toMatch(/HTTP 400/);
    expect(mapped.message).toMatch(/invalid or revoked API token/i);
    expect(mapped.message).toContain(SUBDOMAIN);
    // A bad token fails identically next time.
    expect(mapped.retryable).toBe(false);
  });

  it('keeps the GraphQL error text when the response carries one', () => {
    const raw = new Error(
      'GraphQL Error (Code: 400): {"response":{"errors":[{"message":"Validation error: Field \'nope\' is undefined"}],"status":400},"request":{"query":"query X { nope }"}}',
    );
    const mapped = map(raw);
    expect(mapped.message).toContain("Field 'nope' is undefined");
    expect(mapped.message).not.toContain('query X');
  });

  it('treats a schema validation error as not worth retrying', () => {
    const mapped = map({
      response: { status: 200, errors: [{ message: 'Validation error: cannot query field description' }] },
    });
    expect(mapped.retryable).toBe(false);
  });

  it('treats an unrecognised GraphQL error as retryable', () => {
    const mapped = map({ response: { status: 200, errors: [{ message: 'Internal server problem' }] } });
    expect(mapped.retryable).toBe(true);
  });

  it('explains a DNS or connection failure', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']) {
      const mapped = map({ code });
      expect(mapped.message, code).toContain(ENDPOINT);
      expect(mapped.retryable, code).toBe(true);
    }
  });

  it('explains a timeout', () => {
    const mapped = map({ name: 'TimeoutError' });
    expect(mapped.message).toMatch(/did not respond/i);
    expect(mapped.retryable).toBe(true);
  });

  it('truncates an unreasonably long message', () => {
    const mapped = map(new Error('x'.repeat(5000)));
    expect(mapped.message.length).toBeLessThanOrEqual(500);
  });
});
