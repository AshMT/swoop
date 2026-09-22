/**
 * Runs async work over a bounded number of slots.
 *
 * The poll cycle used to be strictly sequential, which is fine against a hosted
 * provider but not against a local model: an 8B model on CPU can take tens of
 * seconds per ticket, so a morning's backlog takes longer to triage than to
 * handle by hand. Concurrency is bounded rather than unbounded because the
 * point is to keep a slow provider busy, not to flood it — Ollama serialises
 * past its own parallelism setting anyway, and a hosted provider will rate
 * limit.
 */
export interface PoolOptions {
  /** Maximum tasks in flight at once. */
  concurrency: number;
  /** Consulted between tasks; returning false stops starting new ones. */
  shouldContinue?: () => boolean;
}

export async function runPool<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  options: PoolOptions,
): Promise<void> {
  const width = Math.max(1, Math.min(Math.floor(options.concurrency), items.length));
  if (items.length === 0) return;

  let next = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      if (options.shouldContinue && !options.shouldContinue()) return;
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  };

  // allSettled rather than all: `Promise.all` rejects on the first throw and
  // leaves the other slots running unawaited, so a ticket already claimed in
  // the ledger could be left mid-flight with the cycle reported as finished.
  // Every slot is drained, then the first failure is surfaced.
  const outcomes = await Promise.allSettled(Array.from({ length: width }, () => run()));
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure && failure.status === 'rejected') throw failure.reason;
}
