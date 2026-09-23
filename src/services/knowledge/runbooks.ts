import { and, eq, isNull, or } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db';
import { runbooks, tenants } from '../../db/schema';
import { createLogger, describeError } from '../../lib/logger';
import type { Runbook, Tenant } from '../../types';
import { createPsaClient } from '../psa/factory';
import { rankSimilar } from '../triage/similarity';

const log = createLogger('Knowledge');

/**
 * The knowledge Swoop draws on: runbooks written here — "Acme new starters
 * go in Staff-All and get Business Premium" — and the SuperOps knowledge
 * base, synced read-only.
 *
 * Client-specific runbooks outrank general ones for that client's tickets,
 * because the client's own conventions are the ones that apply.
 */

export interface KbRef {
  id: string;
  title: string;
  snippet: string;
  score: number;
  clientSpecific: boolean;
  source: string;
}

export async function searchKnowledge(input: {
  tenantId: string;
  clientId: string | null;
  query: string;
  limit?: number;
  minScore?: number;
}): Promise<KbRef[]> {
  const rows = await db
    .select()
    .from(runbooks)
    .where(
      and(
        eq(runbooks.tenantId, input.tenantId),
        input.clientId ? or(isNull(runbooks.clientId), eq(runbooks.clientId, input.clientId)) : isNull(runbooks.clientId),
      ),
    );
  if (rows.length === 0 || !input.query.trim()) return [];
  const ranked = rankSimilar(
    { subject: input.query, body: '' },
    rows.map((r) => ({ id: r.id, subject: r.title, body: r.body, row: r })),
    { minScore: input.minScore ?? 0.12 },
  );
  return ranked
    .map((entry) => {
      const clientSpecific = Boolean(entry.doc.row.clientId);
      return {
        id: entry.doc.id,
        title: entry.doc.row.title,
        snippet: snippetFor(entry.doc.row.body, entry.sharedTerms),
        score: Math.round((entry.score + (clientSpecific ? 0.1 : 0)) * 100) / 100,
        clientSpecific,
        source: entry.doc.row.source ?? 'swoop',
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 3);
}

/** The full text of one runbook, scoped so a tool cannot read another client's. */
export async function readRunbook(tenantId: string, clientId: string | null, id: string): Promise<Runbook | null> {
  const [row] = await db
    .select()
    .from(runbooks)
    .where(and(eq(runbooks.id, id), eq(runbooks.tenantId, tenantId)))
    .limit(1);
  if (!row) return null;
  if (row.clientId && row.clientId !== clientId) return null;
  return row;
}

function snippetFor(body: string, terms: string[]): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const hit = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - 60);
  const text = flat.slice(start, start + 240);
  return `${start > 0 ? '…' : ''}${text}${start + 240 < flat.length ? '…' : ''}`;
}

/**
 * Pulls the SuperOps knowledge base into the runbook store. Articles are
 * upserted by their SuperOps id and read-only in Swoop; ones deleted in
 * SuperOps are removed here.
 */
export async function syncSuperOpsKb(tenant: Tenant): Promise<{ available: boolean; imported: number; removed: number; error?: string }> {
  const psa = createPsaClient(tenant);
  const seen = new Set<string>();
  let imported = 0;
  try {
    for (let page = 1; page <= 50; page++) {
      const articles = await psa.listKbArticles(page);
      if (articles === null) {
        return { available: false, imported: 0, removed: 0, error: 'This SuperOps schema exposes no knowledge base Swoop could recognise.' };
      }
      if (articles.length === 0) break;
      for (const article of articles) {
        if (seen.has(article.id)) continue;
        seen.add(article.id);
        const [existing] = await db
          .select({ id: runbooks.id })
          .from(runbooks)
          .where(and(eq(runbooks.tenantId, tenant.id), eq(runbooks.source, 'superops'), eq(runbooks.externalId, article.id)))
          .limit(1);
        const values = { title: article.title.slice(0, 300), body: article.body.slice(0, 50_000), updatedAt: Math.floor(Date.now() / 1000), updatedBy: 'SuperOps sync' };
        if (existing) await db.update(runbooks).set(values).where(eq(runbooks.id, existing.id));
        else await db.insert(runbooks).values({ id: uuidv4(), tenantId: tenant.id, clientId: null, source: 'superops', externalId: article.id, ...values });
        imported++;
      }
      if (articles.length < 100) break;
    }
  } catch (err) {
    const message = describeError(err);
    log.warn(`Tenant ${tenant.name}: knowledge base sync failed — ${message}`);
    return { available: true, imported, removed: 0, error: message };
  }

  const stored = await db
    .select({ id: runbooks.id, externalId: runbooks.externalId })
    .from(runbooks)
    .where(and(eq(runbooks.tenantId, tenant.id), eq(runbooks.source, 'superops')));
  const gone = stored.filter((r) => r.externalId && !seen.has(r.externalId));
  for (const row of gone) await db.delete(runbooks).where(eq(runbooks.id, row.id));
  await db.update(tenants).set({ kbLastSyncedAt: Math.floor(Date.now() / 1000) }).where(eq(tenants.id, tenant.id));
  log.info(`Tenant ${tenant.name}: synced ${imported} knowledge base article(s), removed ${gone.length}`);
  return { available: true, imported, removed: gone.length };
}
