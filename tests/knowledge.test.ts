import './setup-env';
import { beforeAll, describe, expect, it } from 'vitest';

describe('runbook search', () => {
  beforeAll(async () => {
    const { initializeDatabase, db } = await import('../src/db');
    const { tenants, clients, runbooks } = await import('../src/db/schema');
    initializeDatabase();
    await db.insert(tenants).values({ id: 't1', name: 'M', slug: 'm', superopsSubdomain: 'x', superopsApiKey: 'k' });
    await db.insert(clients).values([
      { id: 'c1', tenantId: 't1', name: 'Acme' },
      { id: 'c2', tenantId: 't1', name: 'Globex' },
    ]);
    await db.insert(runbooks).values([
      { id: 'g', tenantId: 't1', clientId: null, title: 'New starter checklist', body: 'Create the account, assign a licence, add to groups.' },
      { id: 'a', tenantId: 't1', clientId: 'c1', title: 'Acme new starter', body: 'Acme new starters get Business Premium and the Staff-All group.' },
      { id: 'x', tenantId: 't1', clientId: 'c2', title: 'Globex new starter', body: 'Globex new starters get Business Standard.' },
    ]);
  });

  it('ranks the client’s own runbook first and never shows another client’s', async () => {
    const { searchKnowledge, readRunbook } = await import('../src/services/knowledge/runbooks');
    const hits = await searchKnowledge({ tenantId: 't1', clientId: 'c1', query: 'new starter setup' });
    expect(hits[0].id).toBe('a');
    expect(hits.map((h) => h.id)).not.toContain('x');
    expect(await readRunbook('t1', 'c1', 'x')).toBeNull();
    expect(await readRunbook('t1', 'c1', 'g')).not.toBeNull();
  });
});
