import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db';
import { actionLogs } from '../db/schema';
import { ACTION_IDS } from '../domain/classifications';

/**
 * Calibration metrics.
 *
 * The point of running Swoop read-only is to find out whether its verdicts
 * match what a technician would have done. That is a measurement, not a
 * feeling, and the number that matters is the agreement rate: of the
 * classifications a human has actually reviewed, what share were right.
 * Common industry guidance is to reach roughly 90% before widening scope, and
 * to treat anything under about 85% as a prompt or model problem.
 */

export const AGREEMENT_TARGET = 0.9;
export const AGREEMENT_FLOOR = 0.85;

export interface ClassificationBreakdown {
  classification: string;
  total: number;
  reviewed: number;
  correct: number;
  incorrect: number;
  /** correct / reviewed, or null when nothing has been reviewed yet. */
  agreement: number | null;
  avgConfidence: number | null;
}

export interface ConfusionCell {
  predicted: string;
  actual: string;
  count: number;
}

export interface CalibrationReport {
  /** Rows the poller wrote, excluding infrastructure failures. */
  totalClassified: number;
  /** Rows where the AI call itself failed — a reliability figure, not accuracy. */
  totalFailed: number;
  reviewed: number;
  correct: number;
  incorrect: number;
  agreement: number | null;
  /** How far through the log the team has actually reviewed. */
  reviewCoverage: number | null;
  readiness: 'insufficient-data' | 'below-floor' | 'approaching-target' | 'at-target';
  /** Reviewed count needed before the agreement figure means much. */
  minimumSampleSize: number;
  byClassification: ClassificationBreakdown[];
  confusion: ConfusionCell[];
  highSensitivity: number;
  avgConfidence: number | null;
  /** Mean confidence split by whether the human agreed — the calibration check. */
  avgConfidenceWhenCorrect: number | null;
  avgConfidenceWhenIncorrect: number | null;
  latency: { p50: number | null; p95: number | null; avg: number | null };
  noteDelivery: { posted: number; failed: number };
  daily: Array<{
    date: string;
    total: number;
    reviewed: number;
    correct: number;
    /** correct / reviewed for the day, or null if nothing was reviewed. */
    agreement: number | null;
  }>;
  /**
   * Prompt-and-model versions present in this window, newest first. More than
   * one means the headline agreement rate averages over prompts that are not
   * comparable, which is worth saying out loud.
   */
  promptVersions: Array<{
    fingerprint: string | null;
    total: number;
    reviewed: number;
    correct: number;
    agreement: number | null;
    model: string | null;
    firstSeenAt: number | null;
    lastSeenAt: number | null;
  }>;
}

/** Below this many reviews, an agreement percentage is noise. */
export const MINIMUM_SAMPLE_SIZE = 20;

export interface MetricsQuery {
  tenantId?: string;
  clientId?: string;
  /** Restrict to logs newer than this many days. */
  days?: number;
  /** Restrict to one prompt-and-model version. */
  promptFingerprint?: string;
}

function buildConditions(query: MetricsQuery) {
  const conditions = [];
  if (query.tenantId) conditions.push(eq(actionLogs.tenantId, query.tenantId));
  if (query.clientId) conditions.push(eq(actionLogs.clientId, query.clientId));
  if (query.days && query.days > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - query.days * 86400;
    conditions.push(gte(actionLogs.createdAt, cutoff));
  }
  if (query.promptFingerprint) {
    conditions.push(eq(actionLogs.promptFingerprint, query.promptFingerprint));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function buildCalibrationReport(query: MetricsQuery = {}): Promise<CalibrationReport> {
  const where = buildConditions(query);

  const rows = await db
    .select({
      classification: actionLogs.classification,
      confidence: actionLogs.confidence,
      sensitivity: actionLogs.sensitivity,
      status: actionLogs.status,
      reviewVerdict: actionLogs.reviewVerdict,
      reviewCorrect: actionLogs.reviewCorrectClassification,
      latencyMs: actionLogs.aiLatencyMs,
      notePosted: actionLogs.notePosted,
      createdAt: actionLogs.createdAt,
      promptFingerprint: actionLogs.promptFingerprint,
      aiModel: actionLogs.aiModel,
    })
    .from(actionLogs)
    .where(where);

  const classified = rows.filter((r) => r.status !== 'ai_failed' && r.classification);
  const failed = rows.filter((r) => r.status === 'ai_failed');

  const reviewedRows = classified.filter((r) => r.reviewVerdict === 'correct' || r.reviewVerdict === 'incorrect');
  const correctRows = reviewedRows.filter((r) => r.reviewVerdict === 'correct');
  const incorrectRows = reviewedRows.filter((r) => r.reviewVerdict === 'incorrect');

  const agreement = reviewedRows.length > 0 ? correctRows.length / reviewedRows.length : null;

  // ─── Per-classification breakdown ───────────────────────────────────────────
  const buckets = new Map<string, ClassificationBreakdown & { confidenceSum: number; confidenceCount: number }>();
  const ensure = (label: string) => {
    let bucket = buckets.get(label);
    if (!bucket) {
      bucket = {
        classification: label,
        total: 0,
        reviewed: 0,
        correct: 0,
        incorrect: 0,
        agreement: null,
        avgConfidence: null,
        confidenceSum: 0,
        confidenceCount: 0,
      };
      buckets.set(label, bucket);
    }
    return bucket;
  };

  for (const row of classified) {
    const bucket = ensure(row.classification!);
    bucket.total++;
    if (typeof row.confidence === 'number') {
      bucket.confidenceSum += row.confidence;
      bucket.confidenceCount++;
    }
    if (row.reviewVerdict === 'correct') {
      bucket.reviewed++;
      bucket.correct++;
    } else if (row.reviewVerdict === 'incorrect') {
      bucket.reviewed++;
      bucket.incorrect++;
    }
  }

  const byClassification = [...buckets.values()]
    .map(({ confidenceSum, confidenceCount, ...bucket }) => ({
      ...bucket,
      agreement: bucket.reviewed > 0 ? bucket.correct / bucket.reviewed : null,
      avgConfidence: confidenceCount > 0 ? confidenceSum / confidenceCount : null,
    }))
    .sort((a, b) => b.total - a.total);

  // ─── Confusion matrix: what it said vs what the technician said ─────────────
  const confusionMap = new Map<string, number>();
  for (const row of incorrectRows) {
    const predicted = row.classification!;
    const actual = row.reviewCorrect || '(unspecified)';
    const key = `${predicted}\u0000${actual}`;
    confusionMap.set(key, (confusionMap.get(key) ?? 0) + 1);
  }
  const confusion: ConfusionCell[] = [...confusionMap.entries()]
    .map(([key, count]) => {
      const [predicted, actual] = key.split('\u0000');
      return { predicted, actual, count };
    })
    .sort((a, b) => b.count - a.count);

  // ─── Confidence calibration ─────────────────────────────────────────────────
  const avgConfidence = mean(classified.map((r) => r.confidence));
  const avgConfidenceWhenCorrect = mean(correctRows.map((r) => r.confidence));
  const avgConfidenceWhenIncorrect = mean(incorrectRows.map((r) => r.confidence));

  // ─── Latency ────────────────────────────────────────────────────────────────
  const latencies = classified
    .map((r) => r.latencyMs)
    .filter((v): v is number => typeof v === 'number' && v > 0)
    .sort((a, b) => a - b);

  // ─── Daily volume and agreement ─────────────────────────────────────────────
  const dailyMap = new Map<string, { total: number; reviewed: number; correct: number }>();
  for (const row of classified) {
    if (!row.createdAt) continue;
    const date = new Date(row.createdAt * 1000).toISOString().slice(0, 10);
    const bucket = dailyMap.get(date) ?? { total: 0, reviewed: 0, correct: 0 };
    bucket.total++;
    if (row.reviewVerdict === 'correct' || row.reviewVerdict === 'incorrect') bucket.reviewed++;
    if (row.reviewVerdict === 'correct') bucket.correct++;
    dailyMap.set(date, bucket);
  }
  const daily = [...dailyMap.entries()]
    .map(([date, value]) => ({
      date,
      ...value,
      agreement: value.reviewed > 0 ? value.correct / value.reviewed : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // ─── Prompt versions ────────────────────────────────────────────────────────
  const versionMap = new Map<
    string,
    {
      fingerprint: string | null;
      total: number;
      reviewed: number;
      correct: number;
      model: string | null;
      firstSeenAt: number | null;
      lastSeenAt: number | null;
    }
  >();
  for (const row of classified) {
    const key = row.promptFingerprint ?? '';
    const bucket =
      versionMap.get(key) ??
      {
        fingerprint: row.promptFingerprint ?? null,
        total: 0,
        reviewed: 0,
        correct: 0,
        model: row.aiModel ?? null,
        firstSeenAt: row.createdAt ?? null,
        lastSeenAt: row.createdAt ?? null,
      };
    bucket.total++;
    if (row.reviewVerdict === 'correct' || row.reviewVerdict === 'incorrect') bucket.reviewed++;
    if (row.reviewVerdict === 'correct') bucket.correct++;
    if (row.createdAt) {
      bucket.firstSeenAt = Math.min(bucket.firstSeenAt ?? row.createdAt, row.createdAt);
      bucket.lastSeenAt = Math.max(bucket.lastSeenAt ?? row.createdAt, row.createdAt);
    }
    versionMap.set(key, bucket);
  }
  const promptVersions = [...versionMap.values()]
    .map((bucket) => ({
      ...bucket,
      agreement: bucket.reviewed > 0 ? bucket.correct / bucket.reviewed : null,
    }))
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));

  return {
    totalClassified: classified.length,
    totalFailed: failed.length,
    reviewed: reviewedRows.length,
    correct: correctRows.length,
    incorrect: incorrectRows.length,
    agreement,
    reviewCoverage: classified.length > 0 ? reviewedRows.length / classified.length : null,
    readiness: readinessFor(agreement, reviewedRows.length),
    minimumSampleSize: MINIMUM_SAMPLE_SIZE,
    byClassification,
    confusion,
    highSensitivity: classified.filter((r) => r.sensitivity === 'high').length,
    avgConfidence,
    avgConfidenceWhenCorrect,
    avgConfidenceWhenIncorrect,
    latency: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      avg: mean(latencies),
    },
    noteDelivery: {
      posted: classified.filter((r) => r.notePosted).length,
      failed: classified.filter((r) => !r.notePosted).length,
    },
    daily,
    promptVersions,
  };
}

function readinessFor(agreement: number | null, reviewed: number): CalibrationReport['readiness'] {
  if (agreement === null || reviewed < MINIMUM_SAMPLE_SIZE) return 'insufficient-data';
  if (agreement < AGREEMENT_FLOOR) return 'below-floor';
  if (agreement < AGREEMENT_TARGET) return 'approaching-target';
  return 'at-target';
}

function mean(values: Array<number | null | undefined>): number | null {
  const numbers = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (numbers.length === 0) return null;
  return numbers.reduce((sum, v) => sum + v, 0) / numbers.length;
}

/** `sorted` must already be ascending. */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

/** Lightweight counts for the dashboard header, cheap enough to poll. */
export async function buildQuickStats(query: MetricsQuery = {}): Promise<{
  total: number;
  byClassification: Record<string, number>;
  highSensitivity: number;
  failures: number;
  awaitingReview: number;
  agreement: number | null;
  reviewed: number;
}> {
  const where = buildConditions(query);

  const [totals] = await db
    .select({
      total: sql<number>`count(*)`,
      highSensitivity: sql<number>`sum(case when ${actionLogs.sensitivity} = 'high' then 1 else 0 end)`,
      failures: sql<number>`sum(case when ${actionLogs.status} = 'ai_failed' then 1 else 0 end)`,
      reviewed: sql<number>`sum(case when ${actionLogs.reviewVerdict} in ('correct','incorrect') then 1 else 0 end)`,
      correct: sql<number>`sum(case when ${actionLogs.reviewVerdict} = 'correct' then 1 else 0 end)`,
      awaitingReview: sql<number>`sum(case when ${actionLogs.reviewVerdict} is null and ${actionLogs.status} != 'ai_failed' then 1 else 0 end)`,
    })
    .from(actionLogs)
    .where(where);

  const grouped = await db
    .select({ classification: actionLogs.classification, count: sql<number>`count(*)` })
    .from(actionLogs)
    .where(where)
    .groupBy(actionLogs.classification);

  const byClassification: Record<string, number> = {};
  for (const id of ACTION_IDS) byClassification[id] = 0;
  for (const row of grouped) {
    if (row.classification) byClassification[row.classification] = Number(row.count);
  }

  const reviewed = Number(totals?.reviewed ?? 0);
  const correct = Number(totals?.correct ?? 0);

  return {
    total: Number(totals?.total ?? 0),
    byClassification,
    highSensitivity: Number(totals?.highSensitivity ?? 0),
    failures: Number(totals?.failures ?? 0),
    awaitingReview: Number(totals?.awaitingReview ?? 0),
    reviewed,
    agreement: reviewed > 0 ? correct / reviewed : null,
  };
}
