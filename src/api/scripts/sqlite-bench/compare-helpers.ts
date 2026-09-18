/**
 * What every before/after comparison script in this directory needs: a
 * sampler, a scratch database, and a Mongo half that is allowed to be absent.
 *
 * Extracted when the second comparison script (#3748) reproduced the first
 * one's (#3746) timing loop, scratch-file handling and mongo-optional wrapper
 * almost line for line. A benchmark that measures two engines against each
 * other has to hold both of them to the same stopwatch and the same fixture
 * rules, so these are the parts that most need to be shared rather than
 * re-typed: a script that quietly sampled a different number of runs, or
 * rounded differently, would report a difference it had invented.
 */

import { MongoClient, type Db } from 'mongodb';
import { BENCH_DIR, median, openBenchDatabase, removeDatabase } from './bench-db.ts';

/** Samples taken per measurement. Every script uses the same count, on purpose. */
const RUNS = 5;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

// The scratch directory, the sampler's median and the database removal are
// `./bench-db.ts`'s — one implementation, two entry points, because the two
// halves of this directory were extracted in parallel slices and met here.
export { BENCH_DIR, median, openBenchDatabase, removeDatabase };

/**
 * Median wall time over five samples, after one untimed warm-up.
 *
 * The warm-up matters more than the sample count: the first call pays for
 * statement preparation and a cold page cache that every later call then
 * benefits from, so including it would report a number no steady-state tick
 * ever sees.
 */
export async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const samples: number[] = [];
  let value = await fn();
  for (let i = 0; i < RUNS; i += 1) {
    const startedAt = performance.now();
    value = await fn();
    samples.push(performance.now() - startedAt);
  }
  return { ms: median(samples), value };
}

/** Bytes as KB or MB, for the payload-size columns. */
export function size(bytes: number): string {
  return bytes < 1_000_000
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1_048_576).toFixed(2)} MB`;
}

/**
 * Run `measure` against a throwaway Mongo database, or return `fallback` when
 * there is no Mongo to run it against.
 *
 * A missing Mongo is an ordinary outcome, not a failure: these scripts exist to
 * compare an engine that is being removed against the one replacing it, and the
 * SQLite half is worth running on a machine that has already stopped running
 * the old one. The database is named per invocation and dropped afterwards, so
 * two scripts — or two agents — cannot collide.
 *
 * Only the CONNECT is optional. A wider catch would swallow whatever `measure`
 * throws — a typo in a query, an index that fails to build on the scratch
 * database — and print the same "skipped" line, which reads identically to
 * running on a machine with no Mongo at all. A benchmark that silently reports
 * the fallback row for a broken measurement is worse than one that does not
 * run.
 */
export async function withMongoDatabase<T>(
  namePrefix: string,
  measure: (db: Db) => Promise<T>,
  fallback: T,
): Promise<T> {
  let client: MongoClient | null = null;
  try {
    client = await MongoClient.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
  } catch (err) {
    console.log(`  (mongo half skipped: ${err instanceof Error ? err.message : String(err)})\n`);
    return fallback;
  }
  const db: Db = client.db(`${namePrefix}_${Date.now()}`);
  try {
    return await measure(db);
  } finally {
    // The drop belongs in `finally`, not on the success path: a measurement
    // that throws half way through has still created the database, and a
    // benchmark nobody watches is exactly the kind of thing that leaves them
    // behind. #2491 counted 11,375 test databases leaked on a shared server by
    // suites that were each individually expected to tidy up after themselves.
    // Best-effort, because a failed drop must not replace the caller's result
    // — or the error that caused it — with an error about cleanup.
    await db.dropDatabase().catch(() => {});
    await client.close();
  }
}
