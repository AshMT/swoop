// In-memory live view of tickets currently moving through the processing pipeline.
// The actionLogs row only exists once AI classification finishes, so this tracker
// fills the gap — it lets the Dashboard show a ticket the moment Swoop picks it up
// and animate it through each step in real time. State is ephemeral by design
// (Swoop is single-instance); nothing here needs to survive a restart.

export type PipelineStage =
  | 'detected'      // matched to a client and claimed
  | 'classifying'   // AI is reading the ticket (the slow step)
  | 'posting_note'  // writing the proposal note back to the PSA
  | 'deciding'      // applying the action policy
  | 'executing'     // auto-executing a pre-approved action
  | 'done';         // finished — see `outcome` for the result

export interface PipelineEntry {
  ticketId: string;
  tenantId: string;
  subject: string;
  clientName: string;
  stage: PipelineStage;
  classification: string | null;
  confidence: number | null;
  outcome: string | null; // terminal actionLog status when stage === 'done'
  startedAt: number;
  updatedAt: number;
}

const entries = new Map<string, PipelineEntry>();
const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();

// How long a finished ticket lingers in the live view so the completion is visible.
const DONE_TTL_MS = 12_000;
// Safety net: drop entries that never reached 'done' (e.g. process crashed mid-step).
const STALE_MS = 5 * 60_000;

export function trackStart(p: {
  ticketId: string;
  tenantId: string;
  subject: string;
  clientName: string;
}): void {
  const pending = removalTimers.get(p.ticketId);
  if (pending) {
    clearTimeout(pending);
    removalTimers.delete(p.ticketId);
  }
  const now = Date.now();
  entries.set(p.ticketId, {
    ticketId: p.ticketId,
    tenantId: p.tenantId,
    subject: p.subject || '(no subject)',
    clientName: p.clientName,
    stage: 'detected',
    classification: null,
    confidence: null,
    outcome: null,
    startedAt: now,
    updatedAt: now,
  });
}

export function trackStage(
  ticketId: string,
  stage: Exclude<PipelineStage, 'done'>,
  patch?: { classification?: string | null; confidence?: number | null },
): void {
  const e = entries.get(ticketId);
  if (!e) return;
  e.stage = stage;
  e.updatedAt = Date.now();
  if (patch?.classification !== undefined) e.classification = patch.classification;
  if (patch?.confidence !== undefined) e.confidence = patch.confidence;
}

export function trackDone(ticketId: string, outcome: string): void {
  const e = entries.get(ticketId);
  if (!e) return;
  e.stage = 'done';
  e.outcome = outcome;
  e.updatedAt = Date.now();
  const timer = setTimeout(() => {
    entries.delete(ticketId);
    removalTimers.delete(ticketId);
  }, DONE_TTL_MS);
  // Don't keep the process alive just for a UI cleanup tick.
  if (typeof timer.unref === 'function') timer.unref();
  removalTimers.set(ticketId, timer);
}

export function getActivePipeline(tenantId?: string): PipelineEntry[] {
  const now = Date.now();
  const out: PipelineEntry[] = [];
  for (const e of entries.values()) {
    if (e.stage !== 'done' && now - e.updatedAt > STALE_MS) {
      entries.delete(e.ticketId);
      continue;
    }
    if (tenantId && e.tenantId !== tenantId) continue;
    out.push(e);
  }
  // Newest first so a just-arrived ticket appears at the top.
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

// ─── Execution feed ───────────────────────────────────────────────────────────
// Per-action-log step messages emitted during CIPP execution.
// In-memory; expires 10 minutes after the last step.

export interface FeedStep {
  ts: number;
  message: string;
}

const execFeeds = new Map<string, { steps: FeedStep[]; timer: ReturnType<typeof setTimeout> | null }>();

const FEED_TTL_MS = 10 * 60_000;

function armFeedExpiry(actionLogId: string): void {
  const entry = execFeeds.get(actionLogId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  const t = setTimeout(() => execFeeds.delete(actionLogId), FEED_TTL_MS);
  if (typeof t.unref === 'function') t.unref();
  entry.timer = t;
}

export function addExecStep(actionLogId: string, message: string): void {
  let entry = execFeeds.get(actionLogId);
  if (!entry) {
    entry = { steps: [], timer: null };
    execFeeds.set(actionLogId, entry);
  }
  entry.steps.push({ ts: Date.now(), message });
  armFeedExpiry(actionLogId);
}

export function getExecFeed(actionLogId: string): FeedStep[] {
  return execFeeds.get(actionLogId)?.steps || [];
}
