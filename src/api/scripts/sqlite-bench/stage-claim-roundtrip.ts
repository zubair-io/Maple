/**
 * What the claim's second round trip actually costs, through the real pool.
 *
 * ## Why this script exists
 *
 * The claim wants to be one statement — `UPDATE … RETURNING` — and cannot be.
 * The pool exposes three primitives, and the only one that returns rows,
 * `read`, runs against a read-only connection; `write` and `transaction` go
 * through `bun:sqlite`'s `.run()`, which reports `changes` and
 * `lastInsertRowid` and discards rows. SQLite supports `RETURNING`; the pool's
 * API does not surface it.
 *
 * So a claim is two trips to the writer thread: read a short candidate list,
 * then compare-and-swap each candidate inside one transaction, with
 * `changes === 1` proving this caller won. Safety is identical to a
 * find-and-modify, because the win is established by the write rather than by
 * the prior read — but it is one more round trip than the ideal, and the
 * question is whether that is worth widening the pool's protocol for while five
 * port branches are building on it.
 *
 * This measures it rather than arguing it. Everything here goes through
 * `SqlitePool` against a file-backed database, so the numbers include the
 * `postMessage` hop to a worker thread that the in-process benchmarks
 * (`stage-claim-compare.ts`, which uses a synchronous handle) deliberately
 * leave out.
 *
 *   bun scripts/sqlite-bench/stage-claim-roundtrip.ts            # 60,000 assets
 *   bun scripts/sqlite-bench/stage-claim-roundtrip.ts 200000
 */

import { Database } from 'bun:sqlite';
import { SqlitePool } from '../../src/db/sqlite/pool.ts';
import { LIVE_LOCATION_COUNT_RECOMPUTE_SQL } from '../../src/db/sqlite/ddl/asset-locations.ts';
import { claimStageBatch } from '../../src/db/sqlite/repos/stage-claim.ts';
import {
  STAGE_CLAIM_SQL,
  stageClaimCandidatesSql,
} from '../../src/db/sqlite/repos/stage-runtime.sql.ts';
import { BENCH_DIR, median, openBenchDatabase, removeDatabase } from './compare-helpers.ts';
import { generateLibrary } from './generate.ts';

const DEFAULT_ASSETS = 60_000;
const BATCH = 20;
const RUNS = 40;
const STAGE = 'thumb';
const TARGET_VERSION = 9;
const DB_PATH = `${BENCH_DIR}/stage-claim-roundtrip.db`;

async function build(assetCount: number): Promise<void> {
  const db: Database = await openBenchDatabase(DB_PATH);
  generateLibrary(db, { assetCount });
  db.exec(LIVE_LOCATION_COUNT_RECOMPUTE_SQL);
  db.exec('ANALYZE');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

/** Median over `RUNS` samples, discarding the first as warm-up. */
async function sample(fn: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  await fn();
  for (let i = 0; i < RUNS; i += 1) {
    const startedAt = performance.now();
    await fn();
    samples.push(performance.now() - startedAt);
  }
  return median(samples);
}

/** Put the stage's rows back below target so every sample has work to claim. */
async function rewind(pool: SqlitePool): Promise<void> {
  await pool.write(
    `UPDATE stage_state SET version = 0, attempts = 0, dead = 0, next_attempt_at = NULL
      WHERE stage = ?`,
    [STAGE],
  );
  await pool.write('PRAGMA wal_checkpoint(TRUNCATE)');
}

async function main(): Promise<void> {
  const assetCount = Number.parseInt(process.argv[2] ?? '', 10) || DEFAULT_ASSETS;
  console.log(
    `#3748 — what the claim's extra round trip costs, ${assetCount.toLocaleString()} assets\n`,
  );
  await build(assetCount);
  const pool = await SqlitePool.open({ path: DB_PATH });
  const nowIso = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + 900_000).toISOString();

  try {
    await rewind(pool);

    // The floor: what one hop to a worker thread costs with no SQL behind it.
    const emptyRead = await sample(() => pool.read('SELECT 1 AS x'));
    const emptyWrite = await sample(() => pool.transaction([{ sql: 'SELECT 1', params: [] }]));

    // Half one: the candidate scan.
    const candidateSql = stageClaimCandidatesSql(0, 0);
    const scan = await sample(() =>
      pool.read(candidateSql, [STAGE, TARGET_VERSION, nowIso, BATCH]),
    );

    // Half two: the compare-and-swap batch, on candidates already in hand.
    const rows = (await pool.read<{ asset_id: string }>(candidateSql, [
      STAGE,
      TARGET_VERSION,
      nowIso,
      BATCH,
    ])) as Array<{ asset_id: string }>;
    const swap = await sample(() =>
      pool.transaction(
        rows.map((row) => ({
          sql: STAGE_CLAIM_SQL,
          params: [leaseUntil, row.asset_id, STAGE, TARGET_VERSION, nowIso],
        })),
      ),
    );

    // Both halves, as the runner performs them.
    await rewind(pool);
    const whole = await sample(async () => {
      await claimStageBatch(
        {
          stage: STAGE,
          targetVersion: TARGET_VERSION,
          dependsOn: [],
          limit: BATCH,
          maxAttempts: 3,
        },
        pool,
      );
    });

    console.log(`claim batch ${BATCH}, median of ${RUNS} samples through the worker pool\n`);
    console.log(`  empty read (one hop, no SQL)        ${emptyRead.toFixed(3)} ms`);
    console.log(`  empty transaction (one hop, no SQL) ${emptyWrite.toFixed(3)} ms`);
    console.log(`  candidate scan   (trip 1)           ${scan.toFixed(3)} ms`);
    console.log(`  compare-and-swap (trip 2)           ${swap.toFixed(3)} ms`);
    console.log(`  whole claim      (both trips)       ${whole.toFixed(3)} ms\n`);
    console.log(
      `The cost of NOT having RETURNING is one extra hop — about ${emptyRead.toFixed(3)} ms,\n` +
        `the empty-read figure, since trip 1 is a scan that a RETURNING claim would\n` +
        `still have to do the work of. Compare that against the 16 ms slider budget\n` +
        `and against a stage tick, which spends this once and then seconds in a\n` +
        `handler. Widening the pool's protocol is worth proposing only if this line\n` +
        `is large next to the rest of a tick.`,
    );
  } finally {
    pool.close();
    await removeDatabase(DB_PATH);
  }
}

await main();
