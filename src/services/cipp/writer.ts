import { describeError } from '../../lib/logger';
import { acquireCippToken, CippError, normaliseCippUrl, type CippCredentials } from './client';

/**
 * The only code in Swoop that can change a client's Microsoft 365 tenant.
 *
 * Deliberately separate from CippClient, which is GET-only, and imported by
 * exactly one module: services/execution/executor.ts. A test enforces that.
 * Nothing the AI produces reaches this class directly — the executor builds
 * every request itself from resolved, validated values.
 */

export interface CippWriteResult {
  status: number;
  /** Parsed JSON body, or the raw text when it was not JSON. */
  body: unknown;
}

/** Writes can take a while: CIPP fans some out to Exchange. */
const WRITE_TIMEOUT_MS = 60_000;

export class CippWriter {
  private readonly creds: CippCredentials;

  constructor(creds: CippCredentials) {
    this.creds = { ...creds, apiUrl: normaliseCippUrl(creds.apiUrl) };
  }

  /**
   * POST /api/<endpoint>.
   *
   * Never retried. A write that timed out may still have happened, and
   * repeating a password reset or a licence assignment is worse than
   * reporting that the outcome is unknown. A 401 before anything was sent is
   * the one exception: the token is refreshed and the request sent once.
   */
  async post(endpoint: string, payload: unknown): Promise<CippWriteResult> {
    const path = endpoint.replace(/^\/?(api\/)?/, '');
    const url = `${this.creds.apiUrl}/api/${path}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await acquireCippToken(this.creds, attempt === 2);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
        });
      } catch (err) {
        // The request may or may not have reached CIPP.
        throw new CippUncertainError(`No response from CIPP for ${path}: ${describeError(err)}`);
      }
      // Easy Auth rejects an expired token before the function runs, so a
      // 401 means nothing was done and one retry is safe.
      if (response.status === 401 && attempt === 1) continue;
      if (response.status === 401 || response.status === 403) {
        throw new CippError('CIPP rejected the token for a write. Check the CIPP-API client has write access.', response.status);
      }
      const text = await response.text().catch(() => '');
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status: response.status, body };
    }
    throw new CippError('CIPP write failed');
  }
}

/** The request was sent but no answer came back — the change may have happened. */
export class CippUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CippUncertainError';
  }
}
