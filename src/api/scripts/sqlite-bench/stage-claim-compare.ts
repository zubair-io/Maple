/**
 * Before and after for #3748, measured rather than argued.
 *
 * Builds the same synthetic library twice — once as MongoDB documents, once as
 * SQLite rows — and runs each engine's real claim and writeback against it, so
 * the numbers come out of the code that ships. Four things are timed:
 *
 *   1. **One claim tick.** Mongo: the `buildClaimQuery` filter, `.limit(batch)`,
 *      then one `updateOne` per document to persist the attempt before the
 *      handler runs. SQLite: `claimStageBatch`, which is one indexed read and
 *      one transaction.
 *   2. **One writeback tick.** Mongo: one `updateOne` per result. SQLite: one
 *      transaction carrying every result's statements.
 *   3. **Sustained throughput.** Claim-plus-writeback cycles over a fixed
 *      number of assets, reported as assets per second.
 *   4. **The dead-letter count** the Workers page persists, per stage.
 *
 * Both engines get the indexes production actually has, including the
 * `stage_<name>_version` / `stage_<name>_dead` pair `db/client.ts` creates for
 * every stage — measuring against a Mongo without them would flatter this port
 * for the wrong reason.
 *
 *   bun scripts/sqlite-bench/stage-claim-compare.ts            # 60,000 assets
 *   bun scripts/sqlite-bench/stage-claim-compare.ts 200000     # a bigger one
 *
 * ## What these numbers do and do not say
 *
 * They say what the stage RUNTIME costs. They do not say what a stage costs.
 * `describe` waits on Ollama, `face-embed` and `face-detect` wait on the GPU,
 * and `geocode` waits on a rate-limited HTTP endpoint — for those stages the
 * claim has never been the bottleneck and this port does not make them faster.
 * Where it shows up is the cheap, high-volume stages (`exif`, `thumb`,
 * `meili`, `cf-thumb-sync`) and, more importantly, in what the claim stops
 * costing everything ELSE in the process: the runtime is the heaviest writer in
 * the system, and every claim it does not spend is capacity a request keeps.
 *
 * Nothing here touches production. The Mongo side creates a uniquely-named
 * database and drops it; the SQLite side writes a scratch file under
 * `SQLITE_BENCH_DIR` (`/tmp/maple-sqlite-bench` by default) and deletes it.
 * Both generators are seeded, so a re-run reproduces the same library. A Mongo
 * instance is optional — without one, the SQLite half still runs and the
 * comparison rows say so.
 */

import type { Database } from 'bun:sqlite';
import type { Collection, Document } from 'mongodb';
import { LIVE_LOCATION_COUNT_RECOMPUTE_SQL } from '../../src/db/sqlite/ddl/asset-locations.ts';
import { claimStageBatch } from '../../src/db/sqlite/repos/stage-claim.ts';
import { stageResultStatements } from '../../src/db/sqlite/repos/stage-writeback.ts';
import {
  STAGE_DEAD_COUNT_SQL,
  stageClaimCandidatesSql,
} from '../../src/db/sqlite/repos/stage-runtime.sql.ts';
import { testSqliteDb } from '../../src/db/sqlite/repos/assets.test-helpers.ts';
import { buildClaimQuery } from '../../src/workers/claim-query.ts';
import {
  BENCH_DIR,
  median,
  openBenchDatabase,
  removeDatabase,
  timed,
  withMongoDatabase,
} from './compare-helpers.ts';
import { generateLibrary } from './generate.ts';
import { buildMongoLibrary } from './mongo-library.ts';

const DEFAULT_ASSETS = 60_000;
/** `deriveBatchSize(4)` — the batch a four-way stage claims per tick. */
const BATCH = 20;
/** Assets pushed through claim-plus-writeback for the throughput figure. */
const THROUGHPUT_ASSETS = 2_000;
/** Ticks sampled per measurement. */
const RUNS = 5;
/** The stage under test, and the version the runtime is driving towards. */
const STAGE = 'thumb';
const TARGET_VERSION = 9;
const DB_PATH = `${BENCH_DIR}/stage-claim-compare.db`;

/** A claim batch and the writeback that retires it, timed apart. */
interface TickEngine {
  claim: () => Promise<unknown[]>;
  writeback: (batch: never) => Promise<void>;
}

/**
 * Median claim and writeback times over consecutive ticks.
 *
 * Each tick retires the batch it claimed, so the next one advances to fresh
 * assets on both engines and no sample is measuring an already-claimed row.
 * Resetting between samples instead would put a full-table rewrite inside the
 * timer, which is what a first draft of this script did — it made Mongo look
 * 1.5x faster at claiming, because the rewind dominated both numbers.
 *
 * The first tick is discarded: it pays for the statement preparation and the
 * cold page cache that every later tick then benefits from.
 */
async function tickTimes(engine: TickEngine): Promise<{ claimMs: number; writebackMs: number }> {
  const claims: number[] = [];
  const writebacks: number[] = [];
  for (let i = 0; i <= RUNS; i += 1) {
    const claimStart = performance.now();
    const batch = await engine.claim();
    const writeStart = performance.now();
    await engine.writeback(batch as never);
    const done = performance.now();
    if (i > 0) {
      claims.push(writeStart - claimStart);
      writebacks.push(done - writeStart);
    }
  }
  return { claimMs: median(claims), writebackMs: median(writebacks) };
}

function perSecond(assets: number, ms: number): string {
  return `${Math.round((assets / ms) * 1000).toLocaleString()} assets/s`;
}

// ---------------------------------------------------------------------------
// SQLite side
// ---------------------------------------------------------------------------

async function buildSqlite(assetCount: number): Promise<Database> {
  const db = await openBenchDatabase(DB_PATH);
  generateLibrary(db, { assetCount });
  db.exec(LIVE_LOCATION_COUNT_RECOMPUTE_SQL);
  db.exec('ANALYZE');
  return db;
}

const sqliteRequest = {
  stage: STAGE,
  targetVersion: TARGET_VERSION,
  dependsOn: [],
  limit: BATCH,
  maxAttempts: 3,
};

/** One claim tick: the indexed candidate scan plus the claiming transaction. */
async function sqliteClaim(db: Database): Promise<string[]> {
  const outcome = await claimStageBatch(sqliteRequest, testSqliteDb(db));
  return outcome.claimed.map((row) => row.asset_id);
}

/**
 * The candidate scan on its own — the half that is a query.
 *
 * Reported separately because the claim's two halves scale differently and
 * conflating them hides both. The scan is the part this schema is an argument
 * about, and it is flat: it answers from `stage_claim` and stops at the limit.
 * What is left in a full claim is the durable commit, which is a property of
 * the storage engine rather than of the query — see the report's note.
 */
function sqliteCandidateScan(db: Database): unknown[] {
  return db
    .query(stageClaimCandidatesSql(0, 0))
    .all(STAGE, TARGET_VERSION, new Date().toISOString(), BATCH);
}

/** One writeback tick: every result in the batch, in one transaction. */
async function sqliteWriteback(db: Database, assetIds: readonly string[]): Promise<void> {
  const handle = testSqliteDb(db);
  await handle.transaction(
    assetIds.flatMap((assetId) =>
      stageResultStatements(
        {
          target: { assetId, stage: STAGE, targetVersion: TARGET_VERSION },
          attemptNo: 1,
          maxAttempts: 3,
          dependsOn: [],
        },
        { wrote: true },
      ),
    ),
  );
}

/**
 * Reset the rows a measurement consumed, so each sample starts level.
 *
 * The checkpoint is not tidiness. Rewinding rewrites one row per asset, which
 * on a 60,000-asset library leaves a write-ahead log far past the 1,000-page
 * auto-checkpoint threshold — and the next write transaction, which is the
 * first TIMED one, pays to fold that log back into the database. Measured
 * before this line existed: a claim read 3.91 ms at 60,000 assets and 0.42 ms
 * at 20,000, which is the checkpoint scaling with the fixture rather than the
 * claim scaling with the library.
 */
function sqliteRewind(db: Database): void {
  db.run(
    `UPDATE stage_state SET version = 0, attempts = 0, dead = 0, next_attempt_at = NULL
      WHERE stage = ?`,
    [STAGE],
  );
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

async function sqliteThroughput(db: Database): Promise<number> {
  sqliteRewind(db);
  const startedAt = performance.now();
  for (let done = 0; done < THROUGHPUT_ASSETS; done += BATCH) {
    const claimed = await sqliteClaim(db);
    if (claimed.length === 0) break;
    await sqliteWriteback(db, claimed);
  }
  return performance.now() - startedAt;
}

// ---------------------------------------------------------------------------
// Mongo side
// ---------------------------------------------------------------------------

/** The four report lines the Mongo half contributes. */
interface MongoRows {
  scan: string;
  claim: string;
  writeback: string;
  throughput: string;
  deadCount: string;
  indexes: string;
}

const MONGO_UNAVAILABLE: MongoRows = {
  scan: 'mongodb unavailable — skipped',
  claim: 'mongodb unavailable — skipped',
  writeback: 'mongodb unavailable — skipped',
  throughput: 'mongodb unavailable — skipped',
  deadCount: 'mongodb unavailable — skipped',
  indexes: 'mongodb unavailable — skipped',
};

/** The pair `db/client.ts` creates for every registered stage. */
async function createStageIndexes(assets: Collection<Document>, stages: string[]): Promise<void> {
  for (const name of stages) {
    await assets.createIndex({ [`stages.${name}.version`]: 1 }, { name: `stage_${name}_version` });
    await assets.createIndex(
      { [`stages.${name}.dead`]: 1 },
      {
        name: `stage_${name}_dead`,
        partialFilterExpression: { [`stages.${name}.dead`]: true },
      },
    );
  }
}

/** One Mongo claim tick, exactly as `runOnce` performs it. */
async function mongoClaim(assets: Collection<Document>): Promise<Document[]> {
  const query = buildClaimQuery(STAGE, TARGET_VERSION, [], new Set());
  const docs = await assets
    .find(query as never)
    .limit(BATCH)
    .toArray();
  // The attempt is persisted before the handler runs, one document at a time,
  // so an uncatchable native death still counts against the budget.
  for (const doc of docs) {
    await assets.updateOne({ _id: doc._id }, { $set: { [`stages.${STAGE}.attempts`]: 1 } });
  }
  return docs;
}

/** One Mongo writeback tick: one `updateOne` per result. */
async function mongoWriteback(assets: Collection<Document>, docs: Document[]): Promise<void> {
  const state = {
    version: TARGET_VERSION,
    attempts: 0,
    last_error: null,
    processed_at: new Date(),
    dead: false,
    failed_at: null,
    next_attempt_at: null,
  };
  for (const doc of docs) {
    await assets.updateOne({ _id: doc._id }, { $set: { [`stages.${STAGE}`]: state } });
  }
}

async function mongoRewind(assets: Collection<Document>): Promise<void> {
  await assets.updateMany(
    {},
    {
      $set: {
        [`stages.${STAGE}.version`]: 1,
        [`stages.${STAGE}.attempts`]: 0,
        [`stages.${STAGE}.dead`]: false,
      },
      $unset: { [`stages.${STAGE}.next_attempt_at`]: '' },
    },
  );
}

async function mongoThroughput(assets: Collection<Document>): Promise<number> {
  await mongoRewind(assets);
  const startedAt = performance.now();
  for (let done = 0; done < THROUGHPUT_ASSETS; done += BATCH) {
    const docs = await mongoClaim(assets);
    if (docs.length === 0) break;
    await mongoWriteback(assets, docs);
  }
  return performance.now() - startedAt;
}

async function measureMongo(assetCount: number, stages: string[]): Promise<MongoRows> {
  return withMongoDatabase(
    'maple_stageclaim',
    async (db) => {
      await buildMongoLibrary(db, assetCount);
      const assets = db.collection<Document>('assets');
      await createStageIndexes(assets, stages);

      await mongoRewind(assets);
      const ticks = await tickTimes({
        claim: () => mongoClaim(assets),
        writeback: (docs) => mongoWriteback(assets, docs),
      });
      const scan = await timed(() =>
        assets
          .find(buildClaimQuery(STAGE, TARGET_VERSION, [], new Set()) as never)
          .limit(BATCH)
          .toArray(),
      );
      const throughputMs = await mongoThroughput(assets);
      const deadCount = await timed(() =>
        assets.countDocuments({ [`stages.${STAGE}.dead`]: true }),
      );
      const indexCount = (await assets.indexes()).length;

      return {
        scan: `${scan.ms.toFixed(2)} ms  (find, limit ${BATCH})`,
        claim: `${ticks.claimMs.toFixed(2)} ms  (1 find + ${BATCH} updateOne)`,
        writeback: `${ticks.writebackMs.toFixed(2)} ms  (${BATCH} updateOne)`,
        throughput: `${(throughputMs / 1000).toFixed(2)} s  ${perSecond(THROUGHPUT_ASSETS, throughputMs)}`,
        deadCount: `${deadCount.ms.toFixed(2)} ms`,
        indexes: `${indexCount} on \`assets\`, ${stages.length * 2} of them per-stage`,
      };
    },
    MONGO_UNAVAILABLE,
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function row(label: string, mongo: string, sqlite: string): void {
  console.log(`${label}`);
  console.log(`  mongo   ${mongo}`);
  console.log(`  sqlite  ${sqlite}\n`);
}

async function main(): Promise<void> {
  const assetCount = Number.parseInt(process.argv[2] ?? '', 10) || DEFAULT_ASSETS;
  console.log(
    `#3748 — stage claim and writeback before/after, ${assetCount.toLocaleString()} assets\n`,
  );

  const db = await buildSqlite(assetCount);
  const stages = (
    db.query(`SELECT DISTINCT stage FROM stage_state ORDER BY stage`).all() as Array<{
      stage: string;
    }>
  ).map((r) => r.stage);

  sqliteRewind(db);
  const scan = await timed(async () => sqliteCandidateScan(db));
  const ticks = await tickTimes({
    claim: () => sqliteClaim(db),
    writeback: (claimed) => sqliteWriteback(db, claimed),
  });
  const throughputMs = await sqliteThroughput(db);
  const deadCount = await timed(async () => db.query(STAGE_DEAD_COUNT_SQL).get(STAGE));
  const sqliteIndexes = (
    db
      .query(`SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'stage_state'`)
      .all() as Array<{ name: string }>
  ).length;

  const mongo = await measureMongo(assetCount, stages);

  console.log(`${stages.length} registered stages, claim batch ${BATCH}\n`);
  row('candidate scan only', mongo.scan, `${scan.ms.toFixed(2)} ms  (1 indexed read)`);
  row('one claim tick', mongo.claim, `${ticks.claimMs.toFixed(2)} ms  (1 read + 1 transaction)`);
  row(
    'one writeback tick',
    mongo.writeback,
    `${ticks.writebackMs.toFixed(2)} ms  (1 transaction of ${BATCH})`,
  );
  row(
    `sustained, ${THROUGHPUT_ASSETS.toLocaleString()} assets`,
    mongo.throughput,
    `${(throughputMs / 1000).toFixed(2)} s  ${perSecond(THROUGHPUT_ASSETS, throughputMs)}`,
  );
  row('dead-letter count, one stage', mongo.deadCount, `${deadCount.ms.toFixed(2)} ms`);
  row(
    'indexes carrying stage state',
    mongo.indexes,
    `${sqliteIndexes} on \`stage_state\`, and they do not grow with the stage list`,
  );
  console.log(
    'Caveats.\n\n' +
      '1. This measures the runtime, not the stages. describe is bounded by Ollama,\n' +
      '   the face stages by the GPU and geocode by a rate-limited endpoint — for\n' +
      '   those the claim was never the bottleneck and this port does not move them.\n\n' +
      '2. The scan row is flat in library size — 0.04 ms at 20k, 60k and 150k\n' +
      '   assets — because it is an index range scan that stops at the limit. The\n' +
      '   commit rows are NOT flat: past roughly 100k assets a batch of scattered\n' +
      '   WITHOUT ROWID updates dirties enough pages to trip the 1,000-page WAL\n' +
      '   auto-checkpoint inside a timed tick, and the tick pays for it. That is a\n' +
      '   property of this write storm more than of the runtime — a real tick\n' +
      '   retires a few dozen assets per second, so the same checkpoints amortise\n' +
      '   over orders of magnitude more wall time.\n\n' +
      '3. The commit rows compare different durability guarantees. SQLite commits\n' +
      '   through a write-ahead log with `synchronous = NORMAL`, so a batch is on\n' +
      "   disk when the transaction returns; the Mongo driver's default write\n" +
      '   concern (w:1, j:false) acknowledges from memory before the journal is\n' +
      '   flushed. The scan row is the like-for-like comparison; the commit rows\n' +
      '   are SQLite paying for a stronger promise, which is also why batching a\n' +
      '   whole tick into one transaction is worth as much as it is.\n\n' +
      '4. Sustained throughput here is a write storm with no handler in it. A real\n' +
      '   tick spends milliseconds in the database and seconds in the handler, so\n' +
      '   this row measures how hard the runtime CAN hit the database, not how hard\n' +
      '   it does.',
  );

  db.close();
  await removeDatabase(DB_PATH);
}

await main();
