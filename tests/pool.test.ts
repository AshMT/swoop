import './setup-env';
import { describe, expect, it } from 'vitest';
import { runPool } from '../src/lib/pool';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runPool', () => {
  it('processes every item exactly once', async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const seen: number[] = [];
    await runPool(items, async (item) => { seen.push(item); }, { concurrency: 4 });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('never exceeds the configured width', async () => {
    let inFlight = 0;
    let peak = 0;
    await runPool(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick(2);
        inFlight--;
      },
      { concurrency: 3 },
    );
    expect(peak).toBe(3);
  });

  it('is sequential at concurrency 1 — the previous behaviour', async () => {
    let peak = 0;
    let inFlight = 0;
    await runPool(
      [1, 2, 3, 4],
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick(1);
        inFlight--;
      },
      { concurrency: 1 },
    );
    expect(peak).toBe(1);
  });

  it('does not spawn more slots than there are items', async () => {
    let started = 0;
    await runPool([1, 2], async () => { started++; await tick(1); }, { concurrency: 10 });
    expect(started).toBe(2);
  });

  it('handles an empty list', async () => {
    let called = false;
    await runPool([], async () => { called = true; }, { concurrency: 4 });
    expect(called).toBe(false);
  });

  it('clamps a nonsensical width to at least one', async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3], async (n) => { seen.push(n); }, { concurrency: 0 });
    expect(seen).toHaveLength(3);
  });

  /** Shutdown must stop starting new tickets rather than abandoning the pool. */
  it('stops starting work when shouldContinue turns false', async () => {
    let running = true;
    const seen: number[] = [];
    await runPool(
      Array.from({ length: 50 }, (_, i) => i),
      async (item) => {
        seen.push(item);
        if (seen.length >= 5) running = false;
        await tick(1);
      },
      { concurrency: 2, shouldContinue: () => running },
    );
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(seen.length).toBeLessThan(50);
  });

  /**
   * A worker that throws must not abandon the other slots: in the poller, a
   * ticket is claimed in the dedup ledger before any slow work, so a slot cut
   * short mid-flight would leave that ticket claimed but never classified.
   */
  it('drains every slot before surfacing a worker failure', async () => {
    const completed: number[] = [];
    await expect(
      runPool(
        [1, 2, 3, 4],
        async (item) => {
          if (item === 2) throw new Error('worker exploded');
          await tick(1);
          completed.push(item);
        },
        { concurrency: 2 },
      ),
    ).rejects.toThrow('worker exploded');
    // The other slot kept going rather than being cancelled mid-flight.
    expect(completed.length).toBeGreaterThan(0);
  });

  it('passes the index alongside the item', async () => {
    const pairs: Array<[string, number]> = [];
    await runPool(['a', 'b', 'c'], async (item, index) => { pairs.push([item, index]); }, {
      concurrency: 1,
    });
    expect(pairs).toEqual([['a', 0], ['b', 1], ['c', 2]]);
  });
});
