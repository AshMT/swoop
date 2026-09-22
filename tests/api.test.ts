import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { eq } from 'drizzle-orm';

let app: Express;
let token = '';
let tenantId = '';

const ADMIN = { email: 'admin@msp.test', password: 'a-very-long-test-password' };

beforeAll(async () => {
  const { initializeDatabase } = await import('../src/db');
  const { createApp } = await import('../src/server');
  initializeDatabase();
  app = createApp();
});

function auth(req: request.Test) {
  return req.set('Authorization', `Bearer ${token}`);
}

describe('first-run setup', () => {
  it('reports an unconfigured install', async () => {
    const res = await request(app).get('/api/setup/status').expect(200);
    expect(res.body.setupComplete).toBe(false);
    expect(res.body.hasAdmin).toBe(false);
  });

  it('rejects a short password', async () => {
    const res = await request(app)
      .post('/api/setup/admin')
      .send({ email: ADMIN.email, password: 'short' })
      .expect(400);
    expect(res.body.error).toMatch(/at least 12 characters/);
  });

  it('rejects an invalid email', async () => {
    await request(app).post('/api/setup/admin').send({ email: 'nope', password: ADMIN.password }).expect(400);
  });

  it('creates the admin account and returns a token', async () => {
    const res = await request(app).post('/api/setup/admin').send(ADMIN).expect(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.email).toBe(ADMIN.email);
    token = res.body.token;
  });

  it('refuses to create a second admin', async () => {
    await request(app)
      .post('/api/setup/admin')
      .send({ email: 'other@msp.test', password: ADMIN.password })
      .expect(409);
  });
});

/**
 * Previously every /api/setup route was unauthenticated, so anyone who could
 * reach the port could create a tenant, rewrite the AI configuration, or point
 * the connection tests at the host's internal network.
 */
describe('setup routes are locked down after first run', () => {
  const protectedRoutes: Array<[string, Record<string, unknown>]> = [
    ['/api/setup/tenant', { name: 'Evil', subdomain: 'evil', apiKey: 'x' }],
    ['/api/setup/ai-config', { tenantId: '00000000-0000-0000-0000-000000000000', baseUrl: 'http://x', model: 'm' }],
    ['/api/setup/client', { tenantId: '00000000-0000-0000-0000-000000000000', name: 'Evil' }],
    ['/api/setup/test-superops', { subdomain: 'x', apiKey: 'y' }],
    ['/api/setup/test-ai', { baseUrl: 'http://169.254.169.254', model: 'm' }],
  ];

  for (const [path, body] of protectedRoutes) {
    it(`rejects an unauthenticated POST to ${path}`, async () => {
      await request(app).post(path).send(body).expect(401);
    });
  }

  it('rejects a forged token', async () => {
    await request(app)
      .post('/api/setup/tenant')
      .set('Authorization', 'Bearer not.a.real.token')
      .send({ name: 'Evil', subdomain: 'evil', apiKey: 'x' })
      .expect(401);
  });

  it('rejects a malformed Authorization header', async () => {
    await request(app).get('/api/tenants').set('Authorization', 'Basic abc').expect(401);
  });
});

describe('authentication', () => {
  it('signs in with the right password', async () => {
    const res = await request(app).post('/api/auth/login').send(ADMIN).expect(200);
    expect(res.body.token).toBeTruthy();
  });

  it('rejects the wrong password without revealing whether the account exists', async () => {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: ADMIN.email, password: 'wrong-password-entirely' })
      .expect(401);
    const noSuchUser = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@msp.test', password: 'wrong-password-entirely' })
      .expect(401);
    expect(wrongPassword.body.error).toBe(noSuchUser.body.error);
  });

  it('returns the signed-in user', async () => {
    const res = await auth(request(app).get('/api/auth/me')).expect(200);
    expect(res.body.email).toBe(ADMIN.email);
  });
});

describe('tenants and clients', () => {
  it('creates the tenant', async () => {
    const res = await auth(request(app).post('/api/setup/tenant'))
      .send({ name: 'MightyIT', subdomain: 'mightyit', apiKey: 'super-secret-token', region: 'us' })
      .expect(200);
    tenantId = res.body.id;
    expect(tenantId).toBeTruthy();
  });

  // The API key is encrypted at rest; it must never come back out over HTTP.
  it('never returns the stored API keys', async () => {
    const res = await auth(request(app).get('/api/tenants')).expect(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('super-secret-token');
    expect(body).not.toContain('superopsApiKey');
    expect(res.body[0].hasSuperopsApiKey).toBe(true);
  });

  it('updates operator controls', async () => {
    const res = await auth(request(app).patch(`/api/tenants/${tenantId}`))
      .send({ pollIntervalSeconds: 120, confidenceThreshold: 0.8, dryRun: true })
      .expect(200);
    expect(res.body.pollIntervalSeconds).toBe(120);
    expect(res.body.confidenceThreshold).toBe(0.8);
    expect(res.body.dryRun).toBe(true);
  });

  it('rejects an out-of-range poll interval', async () => {
    await auth(request(app).patch(`/api/tenants/${tenantId}`)).send({ pollIntervalSeconds: 1 }).expect(400);
    await auth(request(app).patch(`/api/tenants/${tenantId}`)).send({ confidenceThreshold: 5 }).expect(400);
  });

  it('404s an unknown tenant', async () => {
    await auth(request(app).get('/api/tenants/00000000-0000-0000-0000-000000000000')).expect(404);
  });

  it('creates a client', async () => {
    const res = await auth(request(app).post('/api/clients'))
      .send({ tenantId, name: 'Acme Corp', superopsCompanyId: 'acct-9', automationEnabled: true })
      .expect(201);
    expect(res.body.name).toBe('Acme Corp');
    expect(res.body.automationEnabled).toBe(true);
  });

  // Two rows for one company would both match and race for the same tickets.
  it('rejects a duplicate client name', async () => {
    const res = await auth(request(app).post('/api/clients'))
      .send({ tenantId, name: 'Acme Corp' })
      .expect(409);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('rejects a duplicate SuperOps company ID', async () => {
    await auth(request(app).post('/api/clients'))
      .send({ tenantId, name: 'Acme Two', superopsCompanyId: 'acct-9' })
      .expect(409);
  });

  it('lists clients with their activity counts', async () => {
    const res = await auth(request(app).get(`/api/clients?tenantId=${tenantId}`)).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].actionCount).toBe(0);
  });
});

describe('action log and calibration', () => {
  it('returns a paginated envelope, not a bare array', async () => {
    const res = await auth(request(app).get('/api/actions')).expect(200);
    expect(res.body).toMatchObject({ items: [], total: 0, hasMore: false });
  });

  it('reports quick stats', async () => {
    const res = await auth(request(app).get('/api/actions/stats')).expect(200);
    expect(res.body.total).toBe(0);
    expect(res.body.agreement).toBeNull();
  });

  it('reports an honest calibration verdict with no data', async () => {
    const res = await auth(request(app).get('/api/actions/metrics')).expect(200);
    expect(res.body.readiness).toBe('insufficient-data');
    expect(res.body.agreement).toBeNull();
    expect(res.body.minimumSampleSize).toBeGreaterThan(0);
  });

  it('exposes the canonical label set so the UI need not hardcode it', async () => {
    const res = await auth(request(app).get('/api/actions/classifications')).expect(200);
    expect(res.body.classifications).toContain('password_reset');
    expect(res.body.classifications).toContain('ESCALATE');
  });

  it('exports CSV with a header row', async () => {
    const res = await auth(request(app).get('/api/actions/export.csv')).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text).toContain('review_verdict');
  });

  /**
   * createdAt has one-second resolution, so a reclassify lands in the same
   * second as the row it re-runs. Ordering previously fell back to the id,
   * which is a random UUID — so "newest first" was a coin flip, and the
   * reclassify toast's promise that the result is at the top was often false.
   */
  it('orders same-second rows by insertion, not by random UUID', async () => {
    const { db } = await import('../src/db');
    const { actionLogs } = await import('../src/db/schema');
    const { randomUUID } = await import('crypto');

    const second = Math.floor(Date.now() / 1000);
    const inserted: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = randomUUID();
      inserted.push(id);
      await db.insert(actionLogs).values({
        id,
        tenantId,
        ticketId: `ORDER-${i}`,
        ticketSubject: `ordering probe ${i}`,
        classification: 'ESCALATE',
        status: 'classified',
        createdAt: second,
      });
    }

    const res = await auth(request(app).get('/api/actions').query({ q: 'ordering probe' })).expect(200);
    const returned = res.body.items.map((item: { id: string }) => item.id);
    // Newest first means the last one written comes back first.
    expect(returned).toEqual([...inserted].reverse());

    for (const id of inserted) {
      await db.delete(actionLogs).where(eq(actionLogs.id, id));
    }
  });

  it('404s an unknown action log', async () => {
    await auth(request(app).get('/api/actions/00000000-0000-0000-0000-000000000000')).expect(404);
  });

  /**
   * A LIKE term is escaped, which only works with a declared ESCAPE character.
   * Without one, searching for "%" matches every row — so this asserts the
   * wildcard is treated as a literal rather than silently ignoring the filter.
   */
  it('treats LIKE wildcards in the search term as literal characters', async () => {
    for (const term of ['%', '_', '%%', 'a_b', '\\']) {
      const res = await auth(request(app).get('/api/actions').query({ q: term })).expect(200);
      expect(res.body.total, `search for ${JSON.stringify(term)}`).toBe(0);
    }
  });

  it('accepts an ordinary search term', async () => {
    const res = await auth(request(app).get('/api/actions').query({ q: 'password' })).expect(200);
    expect(res.body.total).toBe(0);
  });

  it('rejects a search term that is too long', async () => {
    await auth(request(app).get('/api/actions').query({ q: 'x'.repeat(300) })).expect(400);
  });

  it('rejects an out-of-range page size', async () => {
    await auth(request(app).get('/api/actions').query({ limit: 9999 })).expect(400);
    await auth(request(app).get('/api/actions').query({ offset: -1 })).expect(400);
  });

  it('rejects a review verdict that is not a known label', async () => {
    await auth(request(app).post('/api/actions/00000000-0000-0000-0000-000000000000/review'))
      .send({ verdict: 'incorrect', correctClassification: 'not_a_real_action' })
      .expect(400);
  });
});

describe('transport behaviour', () => {
  it('sets security headers', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  // The old catch-all served index.html for unknown /api paths, so a typo'd
  // endpoint returned 200 and a page of HTML the client then tried to parse.
  it('returns a JSON 404 for an unknown API path', async () => {
    const res = await request(app).get('/api/does-not-exist').expect(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error).toBeTruthy();
  });

  it('rejects malformed JSON with a 400, not a stack trace', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": broken')
      .expect(400);
    expect(res.body.error).toMatch(/not valid JSON/);
  });

  it('rejects an oversized body', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'x'.repeat(400_000) })
      .expect(413);
  });

  it('reports health without authentication', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBeTruthy();
  });
});

describe('system status', () => {
  it('surfaces actionable warnings instead of hiding them in the logs', async () => {
    const res = await auth(request(app).get('/api/system/status')).expect(200);
    expect(res.body.tenants).toHaveLength(1);
    // dryRun was switched on above, and the schema has never been probed.
    expect(res.body.warnings.join(' ')).toMatch(/preview mode/i);
    expect(res.body.warnings.join(' ')).toMatch(/has not been probed/i);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/system/status').expect(401);
  });
});

/**
 * The container HEALTHCHECK wires to this endpoint, so it has to be capable of
 * failing. It previously returned 200 unconditionally without touching SQLite,
 * which meant a container with an unreadable database reported healthy and no
 * orchestrator would ever restart it.
 */
describe('health check', () => {
  it('reports ok and the poller state when the database responds', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBeTruthy();
    expect(res.body.poller).toMatch(/running|stopped/);
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });

  it('is never cached by a proxy in front', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('needs no authentication', async () => {
    await request(app).get('/health').expect(200);
  });

  /**
   * Breaks the database for real rather than mocking the probe, because the
   * thing worth proving is that a genuinely unreadable database produces a
   * failing status code — not that a stub can be made to return one.
   */
  it('returns 503 when the database cannot be read', async () => {
    const { getSqlite } = await import('../src/db');
    const sqlite = getSqlite();

    sqlite.exec('ALTER TABLE schema_migrations RENAME TO schema_migrations_hidden');
    try {
      const res = await request(app).get('/health').expect(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.error).toBeTruthy();
      // The version still comes back, so an operator can tell which build failed.
      expect(res.body.version).toBeTruthy();
    } finally {
      sqlite.exec('ALTER TABLE schema_migrations_hidden RENAME TO schema_migrations');
    }

    // And recovers once the database is readable again.
    await request(app).get('/health').expect(200);
  });
});
