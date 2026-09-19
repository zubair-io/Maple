/**
 * How many reader threads the pool needs, and what it costs to lose one
 * (#3797, #3782).
 *
 * Two questions, one rig. The first is sizing: `DEFAULT_READER_COUNT` was 2,
 * reasoned from "WAL lets readers run concurrently" — an argument about
 * correctness standing in for one about capacity. The second is respawn: if a
 * reader dies, what does the pool actually lose? The answer turns out not to be
 * "1/N of the throughput", which is why #3782 stopped being optional.
 *
 * Both are measured the same way: a real pool on a generated library of the
 * production shape, one request-path read at a time (an indexed point lookup on
 * `assets`, the shape a grid page or a File Provider enumeration issues) while
 * a controllable number of genuinely slow reads loop on the other readers.
 *
 * The slow read is not synthetic. It is the Workers page's `pending` count for
 * `describe` — an unbounded `COUNT` over the stage backlog, which has no limit
 * to stop it early and which the worker tier runs once per stage per pass,
 * faster while an operator has the Workers page open. #3796 removed the two
 * slow stage claims; this one survives it, so it is the load the pool has to
 * absorb today rather than the one it used to have.
 *
 *   bun scripts/sqlite-bench/reader-pool.ts             # 120,000 assets
 *   bun scripts/sqlite-bench/reader-pool.ts 335000      # production shape
 *
 * Nothing here touches production: the database is a scratch file under
 * `SQLITE_BENCH_DIR` (`/tmp/maple-sqlite-bench` by default), built by the same
 * seeded generator every other script in this directory uses, and deleted at
 * the end.
 */

import { availableParallelism } from 'node:os';
import { SqlitePool } from '../../src/db/sqlite/pool.ts';
import { defaultReaderCount, readerCountFromEnvironment } from '../../src/db/sqlite/protocol.ts';
import { stagePendingCountSql } from '../../src/db/sqlite/repos/stage-runtime.sql.ts';
import { BENCH_DIR, buildLibrary, removeDatabase, sizeArgument } from './bench-db.ts';

const DEFAULT_ASSETS = 120_000;
const DB_PATH = `${BENCH_DIR}/reader-pool.db`;

/** How long each cell of the tables runs its load for. */
const WINDOW_MS = 4_000;

/**
 * The stage whose backlog count is the slow read. `describe` is the one the
 * Workers page spends the longest on, and it carries no residual, so the cost
 * is the backlog scan itself rather than anything #3796 addressed.
 */
const SLOW_SQL = stagePendingCountSql();

/**
 * `describe` with a target version nothing has reached, which is the state the
 * count is expensive in and the state a stage spends most of its life in: the
 * scan has no limit to stop it, so it runs the length of the backlog.
 */
const SLOW_PARAMS = ['describe', 1_000_000] as const;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** The request-path read: one asset by id, served by the primary key. */
const POINT_SQL = `SELECT id, size, rating, media_kind FROM assets WHERE id = ?`;

interface Sample {
  /** Request-path reads that completed inside the window. */
  reads: number;
  /** Reads rejected because no reader was alive to run them. */
  errors: number;
  p50: number;
  p95: number;
  max: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? Number.NaN;
}

function summarise(samples: readonly number[], errors = 0): Sample {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    reads: sorted.length,
    errors,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? Number.NaN,
  };
}

/**
 * Whether a rejection is one this script deliberately caused by killing a
 * reader, as opposed to a defect in the rig.
 *
 * The distinction matters: the first version of this script caught every
 * rejection, and a point lookup naming a column that does not exist came back
 * in 0.0 ms, 223,738 times. Only the two shapes a terminated reader produces
 * are tolerated; anything else still throws.
 */
function isExpectedReaderDeath(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /worker (exited|was terminated)|every reader worker/.test(text);
}

function ms(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value >= 100 ? `${Math.round(value).toLocaleString()}` : value.toFixed(1);
}

/**
 * Runs `count` slow reads in a loop until the returned stop function is called.
 *
 * Each loop re-issues as soon as its previous read answers, which is what makes
 * it a *sustained* occupant of a reader rather than a burst: the pool never
 * sees the thread go idle, so routing has no moment at which the reader looks
 * free.
 */
function startSlowLoad(pool: SqlitePool, count: number): () => Promise<void> {
  let running = true;
  const loops = Array.from({ length: count }, async () => {
    while (running) {
      try {
        await pool.read(SLOW_SQL, [...SLOW_PARAMS]);
      } catch (error) {
        // A reader dying under an in-flight read is staged by this script. Any
        // other rejection is a defect in the rig and must not be swallowed.
        if (!isExpectedReaderDeath(error)) throw error;
        // And the same macrotask yield {@link timedRead} needs, for the same
        // reason and with sharper consequences: a rejection arrives on the
        // microtask queue, so retrying with no delay starves every timer in the
        // process — including the respawn that would end the outage. Without
        // this the pool-of-two-with-both-killed row hung indefinitely, because
        // the rig had made the recovery it was measuring impossible.
        await sleep(1);
      }
    }
  });
  return async () => {
    running = false;
    await Promise.all(loops);
  };
}

/**
 * One request-path read, timed — or null when the pool had no live reader to
 * run it on, which is a read that did not happen rather than a slow one.
 *
 * The null path yields a real macrotask before returning. A pool with no live
 * reader rejects on the microtask queue, so a caller that retries with no delay
 * never lets the queue drain, and the respawn's backoff is a `setTimeout` on
 * the other side of it. Without the yield the two-readers-killed row reported
 * 5,832,410 failed reads and no respawn — the rig starving the fix rather than
 * the fix not working. No production caller retries a rejected read in a tight
 * loop; each is an HTTP handler that returns, or a poll loop with an interval.
 */
async function timedRead(pool: SqlitePool, id: string): Promise<number | null> {
  const startedAt = performance.now();
  try {
    const rows = await pool.read(POINT_SQL, [id]);
    if (rows.length !== 1) {
      throw new Error(`reader-pool bench: point lookup returned ${rows.length} rows`);
    }
    return performance.now() - startedAt;
  } catch (error) {
    if (!isExpectedReaderDeath(error)) throw error;
    await sleep(1);
    return null;
  }
}

/** One request-path read at a time for `WINDOW_MS`, timed individually. */
async function sampleRequestPath(pool: SqlitePool, id: string): Promise<Sample> {
  const samples: number[] = [];
  const until = performance.now() + WINDOW_MS;
  let errors = 0;
  while (performance.now() < until) {
    const elapsed = await timedRead(pool, id);
    if (elapsed === null) errors += 1;
    else samples.push(elapsed);
  }
  return summarise(samples, errors);
}

/**
 * A pool, warmed so no cell pays for statement preparation.
 *
 * Retried because this script opens and closes pools in a tight loop, which
 * production never does: `close()` terminates the writer thread, and the file
 * lock it held is released by the OS a moment later. The next open can lose
 * that race and see SQLITE_BUSY. A rig artefact, not a pool defect.
 */
async function openOnce(readers: number, respawn: boolean): Promise<SqlitePool> {
  // An empty ladder retires a dead reader on the spot, which is exactly the
  // behaviour that shipped before #3782 — so the same rig measures both sides
  // of that change without a second code path.
  const pool = await SqlitePool.open(
    respawn ? { path: DB_PATH, readers } : { path: DB_PATH, readers, respawnDelaysMs: [] },
  );
  await Promise.all(Array.from({ length: readers }, () => pool.read(SLOW_SQL, [...SLOW_PARAMS])));
  return pool;
}

async function openWarm(readers: number, respawn = true): Promise<SqlitePool> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await openOnce(readers, respawn);
    } catch (error) {
      if (attempt >= 5) throw error;
      await sleep(250);
    }
  }
}

/** Closes a pool and lets the OS release its file lock before the next open. */
async function closeAndSettle(pool: SqlitePool): Promise<void> {
  pool.close();
  await sleep(100);
}

/** One cell: `slow` sustained long reads on `pool`, timed point lookups beside them. */
async function cell(pool: SqlitePool, slow: number, id: string): Promise<Sample> {
  const stop = startSlowLoad(pool, slow);
  const sample = await sampleRequestPath(pool, id);
  await stop();
  return sample;
}

function printRow(label: string, sample: Sample): void {
  console.log(
    `| ${label.padEnd(26)} | ${ms(sample.p50).padStart(8)} | ${ms(sample.p95).padStart(8)} | ` +
      `${ms(sample.max).padStart(9)} | ${String(sample.reads).padStart(7)} | ` +
      `${String(sample.errors).padStart(6)} |`,
  );
}

function printHeader(title: string): void {
  console.log(`\n### ${title}\n`);
  console.log(
    `| ${''.padEnd(26)} | ${'p50 ms'.padStart(8)} | ${'p95 ms'.padStart(8)} | ` +
      `${'max ms'.padStart(9)} | ${'reads'.padStart(7)} | ${'failed'.padStart(6)} |`,
  );
  console.log(
    `| ${'-'.repeat(26)} | ${'-'.repeat(8)} | ${'-'.repeat(8)} | ` +
      `${'-'.repeat(9)} | ${'-'.repeat(7)} | ${'-'.repeat(6)} |`,
  );
}

/**
 * Table A — sizing. Reader count against sustained long reads.
 *
 * The result #3796 found and this re-takes: N readers tolerate N−1 concurrent
 * long reads and collapse at N.
 */
async function tableSizing(id: string): Promise<void> {
  printHeader(`Sizing: request-path read, ${WINDOW_MS / 1000}s window`);
  for (const readers of [1, 2, 3, 4, 8]) {
    // Zero slow reads on the pool of two is the control: what an uncontended
    // request-path read costs, so the collapsed rows have something to be read
    // against. Beyond N slow reads there is nothing left to learn — the pool is
    // already fully occupied.
    const loads = readers === 2 ? [0, 1, 2] : [1, 2, 3, 4].filter((slow) => slow <= readers);
    const pool = await openWarm(readers);
    try {
      for (const slow of loads) {
        printRow(`${readers} readers, ${slow} slow`, await cell(pool, slow, id));
      }
    } finally {
      await closeAndSettle(pool);
    }
  }
}

/**
 * Table B — what losing a reader costs, which is the question #3782 is about.
 *
 * A pool is opened at its full width, readers are killed, and the survivors are
 * measured under a fixed load. With respawn off — the behaviour that shipped —
 * the loss is permanent, and because the pool is a cliff rather than a slope the
 * last reader to go takes everything with it.
 */
async function tableDegraded(id: string, width: number, slow: number): Promise<void> {
  printHeader(
    `Degraded, respawn OFF: a pool of ${width} losing readers, ${slow} sustained slow reads`,
  );
  for (let dead = 0; dead < width; dead += 1) {
    const pool = await openWarm(width, false);
    try {
      killReaders(pool, dead);
      printRow(`${dead} dead, ${width - dead} alive`, await cell(pool, slow, id));
    } finally {
      await closeAndSettle(pool);
    }
  }
}

/**
 * Table B′ — the same kills against a pool that respawns, on real threads.
 *
 * The unit tests pin the policy against a stand-in worker; this is the end-to-end
 * version, with genuine threads dying and genuine SQLite connections reopening
 * underneath a live read load. Each row kills its readers at the start of the
 * window rather than before it, so the measurement spans the outage and the
 * recovery instead of starting after both.
 */
async function tableRespawn(id: string, width: number, slow: number): Promise<void> {
  printHeader(`Same kills, respawn ON: a pool of ${width}, ${slow} sustained slow reads`);
  for (let dead = 1; dead <= width; dead += 1) {
    const pool = await openWarm(width);
    try {
      const stop = startSlowLoad(pool, slow);
      killReaders(pool, dead);
      const sample = await sampleRequestPath(pool, id);
      await stop();
      const restarts = pool.stats().readers.reduce((total, r) => total + r.restarts, 0);
      printRow(`${dead} killed, ${restarts} respawned`, sample);
    } finally {
      await closeAndSettle(pool);
    }
  }
}

/**
 * Kills `count` readers by terminating their threads, which is what the pool
 * sees when a worker crashes: the handle's `close` listener fires and the
 * handle marks itself dead.
 *
 * Reaching into the private array is the only way to stage this — a real thread
 * cannot be asked to die on cue, and the fake worker the unit tests use cannot
 * run SQL. It is a benchmark, not shipped code.
 */
function killReaders(pool: SqlitePool, count: number): void {
  const readers = (pool as unknown as { readers: Array<{ terminate(): void }> }).readers;
  for (let i = 0; i < count; i += 1) readers[i]?.terminate();
}

/**
 * Table C — a search, which is the API process's real shape.
 *
 * `searchFacets` issues its twelve statements together rather than in sequence,
 * so the route waits for the slowest rather than for the sum — but only if
 * there are readers to spread them across. On a pool of two, ten of the twelve
 * queue, and the route waits for the sum after all. Each read here is the same
 * backlog count the other tables use, which stands in for the six facets #3768
 * measures at 252–1,134 ms.
 */
async function tableSearchBurst(): Promise<void> {
  console.log(`\n### A 12-wide search fan-out, wall time for the whole burst\n`);
  for (const readers of [2, 3, 4, 6, 8, 12]) {
    const pool = await openWarm(readers);
    try {
      const samples: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        const startedAt = performance.now();
        await Promise.all(Array.from({ length: 12 }, () => pool.read(SLOW_SQL, [...SLOW_PARAMS])));
        samples.push(performance.now() - startedAt);
      }
      console.log(`${String(readers).padStart(2)} readers: ${ms(summarise(samples).p50)} ms`);
    } finally {
      await closeAndSettle(pool);
    }
  }
}

/** Table D — what a reader costs, since the sizing argument spends them. */
async function tableCost(): Promise<void> {
  console.log(`\n### Cost of a reader\n`);
  // Absolute RSS rather than a delta: a Worker's heap is its own, so the host's
  // delta is dominated by GC noise and came out negative on the first run.
  for (const readers of [2, 4, 8, 16]) {
    const startedAt = performance.now();
    const pool = await SqlitePool.open({ path: DB_PATH, readers });
    const openMs = performance.now() - startedAt;
    await Promise.all(Array.from({ length: readers }, () => pool.read(SLOW_SQL, [...SLOW_PARAMS])));
    const rss = process.memoryUsage().rss;
    await closeAndSettle(pool);
    console.log(
      `${String(readers).padStart(2)} readers: open ${openMs.toFixed(0)} ms, ` +
        `process RSS ${(rss / 2 ** 20).toFixed(0)} MB`,
    );
  }
}

async function main(): Promise<void> {
  const assetCount = sizeArgument(Bun.argv.slice(2), DEFAULT_ASSETS);
  console.log(`Building a ${assetCount.toLocaleString()}-asset library at ${DB_PATH}…`);
  const built = await buildLibrary(DB_PATH, assetCount);
  const seed = built.query(`SELECT id FROM assets LIMIT 1`).get() as { id: string };
  const backlog = built.query(SLOW_SQL).get(...SLOW_PARAMS) as { n: number };
  built.close();

  console.log(
    `\nBox: ${availableParallelism()} available parallelism. ` +
      `Default this run would pick: ${defaultReaderCount()} readers ` +
      `(env override ${readerCountFromEnvironment() ?? 'unset'}).`,
  );
  console.log(
    `Slow read: the Workers page 'pending' count for describe, over ` +
      `${backlog.n.toLocaleString()} rows.`,
  );

  await tableSizing(seed.id);
  await tableDegraded(seed.id, defaultReaderCount(), 2);
  await tableDegraded(seed.id, 2, 1);
  await tableRespawn(seed.id, 2, 1);
  await tableSearchBurst();
  await tableCost();

  await removeDatabase(DB_PATH);
}

await main();
