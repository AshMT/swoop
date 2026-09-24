import './setup-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireCippToken } from '../src/services/cipp/client';

/**
 * Entra's sign-in errors, turned into what to do about them. The commonest
 * cause in practice: adding or resetting the client in CIPP replaces the
 * app's secret, and the Value is only ever shown once.
 */

let seq = 0;
const creds = () => ({ apiUrl: 'https://cipp.test', tenantId: `msp-${++seq}`, clientId: 'client', clientSecret: 'old' });

function entraSays(description: string) {
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify({ error: 'invalid_client', error_description: `${description}\r\nTrace ID: x` }), { status: 401 }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('CIPP token errors', () => {
  it('explains a replaced or mis-pasted secret, and how to make a new one', async () => {
    entraSays('AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID');
    await expect(acquireCippToken(creds(), true)).rejects.toThrow(/replaced it, or the Secret ID was pasted.*Reset Application Secret.*shown only once/);
  });

  it('names an expired secret', async () => {
    entraSays("AADSTS7000222: The provided client secret keys for app 'x' are expired.");
    await expect(acquireCippToken(creds(), true)).rejects.toThrow(/has expired\. Create a new one/);
  });

  it('points at the client and tenant IDs when the app is not found', async () => {
    entraSays("AADSTS700016: Application with identifier 'client' was not found in the directory 'msp'.");
    await expect(acquireCippToken(creds(), true)).rejects.toThrow(/no app with this Client ID in this tenant/);
  });

  it('passes anything else through with Entra’s own words', async () => {
    entraSays('AADSTS50034: Something unusual.');
    await expect(acquireCippToken(creds(), true)).rejects.toThrow(/Entra ID refused the CIPP token request: AADSTS50034: Something unusual\./);
  });
});
