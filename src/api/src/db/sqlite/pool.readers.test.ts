/**
 * How wide the pool is, and who gets to decide (#3797).
 *
 * The count was a hardcoded 2, justified by "WAL lets readers run concurrently"
 * — an argument about correctness standing in for one about capacity. Measured
 * (`scripts/sqlite-bench/reader-pool.ts`), a pool of N tolerates N−1 sustained
 * long reads and collapses at N, so two was not a small pool but a pool with
 * exactly one spare, and the process generates two long reads on its own.
 *
 * Two things are pinned here. The default is derived from the box rather than
 * being a constant, with a floor and a ceiling that are the actual product
 * decision. And an operator can override it without a deploy, which is the
 * whole point: during the outage that prompted this, widening the pool meant
 * editing source and redeploying.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { availableParallelism } from 'node:os';

import { SqlitePool } from './pool.ts';
import { fakeWorkers } from './pool.test-helpers.ts';
import { defaultReaderCount, readerCountFromEnvironment, READER_COUNT_ENV } from './protocol.ts';

/** Restores whatever the environment had, so these cannot leak into other files. */
const original = process.env[READER_COUNT_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[READER_COUNT_ENV];
  else process.env[READER_COUNT_ENV] = original;
});

function setOverride(value: string): void {
  process.env[READER_COUNT_ENV] = value;
}

describe('the default reader count', () => {
  test('scales with the box, keeping two cores for the worker child', () => {
    // The reserve is the part worth pinning: the API process is not alone on
    // the machine — it spawns the worker child that runs the enrichment tier,
    // and sizing the reader pool to every core would have the database's own
    // threads compete with the work they are feeding.
    expect(defaultReaderCount()).toBe(Math.min(8, Math.max(4, availableParallelism() - 2)));
  });

  test('never drops below four, however small the box', () => {
    // Four tolerates three sustained long reads. Three is what this process can
    // occupy on its own — the worker tier's backlog counts, the change feed,
    // and an operator with the Workers page open, which tightens that counts
    // pass exactly when an incident makes them open it.
    expect(defaultReaderCount()).toBeGreaterThanOrEqual(4);
  });

  test('never climbs above eight unasked', () => {
    // Past eight the request-path read is already flat under load and a 12-wide
    // search fan-out starts getting slower rather than faster, because the work
    // is CPU-bound and the threads only compete. An operator who wants more
    // sets the override.
    expect(defaultReaderCount()).toBeLessThanOrEqual(8);
  });
});

describe('the operator override', () => {
  test('is absent by default', () => {
    delete process.env[READER_COUNT_ENV];
    expect(readerCountFromEnvironment()).toBeNull();
  });

  test('is read as an integer when set', () => {
    setOverride('6');
    expect(readerCountFromEnvironment()).toBe(6);
  });

  test('treats an empty value as unset rather than as zero', () => {
    // A deploy template that renders the variable with no value must not take
    // the pool down; an unset knob is the default, not an invalid one.
    setOverride('   ');
    expect(readerCountFromEnvironment()).toBeNull();
  });

  test('refuses a value it cannot honour, naming the variable', () => {
    // Loudly, rather than silently reverting to the default: an operator who
    // widened the pool during an outage and quietly got the old number back
    // would conclude widening it did not help and go looking elsewhere.
    for (const bad of ['eight', '0', '-2', '2.5', '65', '1e3']) {
      setOverride(bad);
      expect(() => readerCountFromEnvironment()).toThrow(READER_COUNT_ENV);
    }
  });

  test('widens a real pool without a code change', async () => {
    setOverride('5');
    const { spawned, spawn } = fakeWorkers();
    const pool = await SqlitePool.open({ path: '/unused', spawnWorker: spawn });
    try {
      expect(pool.stats().readers).toHaveLength(5);
      expect(spawned.filter((worker) => worker.role === 'reader')).toHaveLength(5);
      expect(spawned.filter((worker) => worker.role === 'writer')).toHaveLength(1);
    } finally {
      pool.close();
    }
  });

  test('a caller that asks for a count still gets it', async () => {
    // The lens-profile cache opens a pool for one lookup and asks for a single
    // reader. An operator widening the main pool must not widen that too.
    setOverride('5');
    const { spawn } = fakeWorkers();
    const pool = await SqlitePool.open({ path: '/unused', readers: 1, spawnWorker: spawn });
    try {
      expect(pool.stats().readers).toHaveLength(1);
    } finally {
      pool.close();
    }
  });

  test('a bad override fails the open rather than starting a differently-sized pool', async () => {
    setOverride('nonsense');
    const { spawned, spawn } = fakeWorkers();
    const error = await SqlitePool.open({ path: '/unused', spawnWorker: spawn }).then(
      (pool) => {
        pool.close();
        return null;
      },
      (e: Error) => e,
    );

    expect(error?.message).toContain(READER_COUNT_ENV);
    // Nothing was spawned, so a refused open leaves no threads behind — the
    // same contract the rest of the fail-closed startup has.
    expect(spawned).toHaveLength(0);
  });
});
