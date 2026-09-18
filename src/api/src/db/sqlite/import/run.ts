/**
 * The importer's driver: read the plan, batch the source, commit rows and the
 * checkpoint together, then put the derived structures back.
 *
 * ## The shape of a run
 *
 * 1. Open the destination and migrate it, so the importer never assumes a
 *    schema someone else created.
 * 2. Drop the derived triggers. `asset_locations` maintains
 *    `assets.live_location_count` with three triggers, and `asset_search`
 *    maintains the FTS5 index with three more; leaving them on would turn a
 *    bulk load into a few million single-row `UPDATE`s and index writes. The
 *    schema exports both trigger sets and the statements that rebuild what they
 *    maintain, precisely so an importer can do this.
 * 3. Walk the plan in foreign-key order, one collection at a time, batching on
 *    `_id` ascending.
 * 4. Put the triggers back, recompute `live_location_count` in one statement,
 *    rebuild and optimise the FTS index.
 * 5. Resolve the references the source could not enforce, then confirm with
 *    `PRAGMA foreign_key_check`.
 *
 * ## Why batches are keyed on `_id`
 *
 * A resumed run continues from `_id > <last committed>`, and the checkpoint
 * that records it commits in the SAME transaction as the rows. So the pair is
 * always consistent: there is no window where rows exist without the checkpoint
 * describing them, or the reverse. A skip/limit pager would have neither
 * property — an offset shifts under any concurrent write, and a crash between
 * the page and the bookkeeping would lose or repeat a page.
 *
 * ## Foreign keys are off during the load
 *
 * Not for speed. The source has a genuine cycle — a face points at a person, a
 * person's cover points at an asset — so no ordering of collections satisfies
 * every constraint at insert time. Enforcement moves to step 5, where it
 * becomes a single pass that can also report what it found. See `repair.ts`.
 */

import { Database } from 'bun:sqlite';
import { existsSync, unlinkSync } from 'node:fs';
import { MongoClient, type Db, type Document, type Filter } from 'mongodb';
import { ALL_STAGE_NAMES } from '../../../workers/stages/stage-names.ts';
import {
  ASSET_LOCATIONS_TRIGGER_DDL,
  ASSET_LOCATIONS_TRIGGER_NAMES,
  LIVE_LOCATION_COUNT_RECOMPUTE_SQL,
} from '../ddl/asset-locations.ts';
import {
  ASSET_SEARCH_TRIGGER_DDL,
  ASSET_SEARCH_TRIGGER_NAMES,
  ASSETS_FTS_OPTIMIZE_SQL,
  ASSETS_FTS_REBUILD_SQL,
} from '../ddl/search.ts';
import { fromBunSqlite, runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from '../migrations/index.ts';
import {
  clearBookkeeping,
  ensureBookkeeping,
  readCheckpoint,
  readMeta,
  readRejects,
  writeCheckpoint,
  writeMeta,
  writeReject,
} from './bookkeeping.ts';
import { CHANGES_FLOOR_KEY } from './plan/library.ts';
import { IMPORT_PLAN } from './plan/index.ts';
import { foreignKeyViolations, REPAIR_META_KEY, repairForeignKeys } from './repair.ts';
import type {
  CollectionPlan,
  CollectionResult,
  ImportOptions,
  ImportReport,
  MapContext,
} from './types.ts';
import { RowWriter, writeBatch, type MappedDocument } from './writer.ts';

/**
 * Pragmas for the load. `foreign_keys` is deliberately absent — see the module
 * comment — and `synchronous = OFF` is safe here in a way it is not for the
 * server: a crash mid-import is recovered by resuming, not by trusting the
 * file, and the checkpoint is only ever read back after a clean restart.
 */
const LOAD_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA synchronous = OFF',
  'PRAGMA cache_size = -65536',
  'PRAGMA temp_store = MEMORY',
] as const;

const TRIGGER_NAMES = [...ASSET_LOCATIONS_TRIGGER_NAMES, ...ASSET_SEARCH_TRIGGER_NAMES];

/** An open destination database plus the Mongo handle feeding it. */
export interface ImportSession {
  sqlite: Database;
  mongo: Db;
  client: MongoClient;
}

/** Opens the destination, migrates it, and connects to the source. */
export async function openImportSession(options: ImportOptions): Promise<ImportSession> {
  if (options.restart && existsSync(options.sqlitePath)) unlinkSync(options.sqlitePath);
  const sqlite = new Database(options.sqlitePath, { create: true });
  for (const pragma of LOAD_PRAGMAS) sqlite.exec(pragma);
  await runMigrations(fromBunSqlite(sqlite), ALL_MIGRATIONS);
  ensureBookkeeping(sqlite);
  if (options.restart) clearBookkeeping(sqlite);

  const client = new MongoClient(options.mongoUri);
  await client.connect();
  return { sqlite, mongo: client.db(options.mongoDb), client };
}

/** Closes both handles. */
export async function closeImportSession(session: ImportSession): Promise<void> {
  session.sqlite.close();
  await session.client.close();
}

/**
 * Resolves and remembers a plan's source filter.
 *
 * The bound is persisted on first use because a resumed run must read exactly
 * the same set as the run it continues — the change log's window is computed
 * from the current highest cursor, and recomputing it after the source has
 * moved on would shift the floor under an already-imported prefix.
 */
async function resolveFilter(
  sqlite: Database,
  mongo: Db,
  plan: CollectionPlan,
  options: ImportOptions,
): Promise<Filter<Document>> {
  if (plan.bound === undefined) return {};
  const key = `bound:${plan.source}`;
  const remembered = readMeta(sqlite, key);
  if (remembered !== null) return JSON.parse(remembered) as Filter<Document>;
  const computed = (await plan.bound(mongo, options)) ?? {};
  writeMeta(sqlite, key, JSON.stringify(computed));
  const floor = (computed as { cursor?: { $gte?: number } }).cursor?.$gte;
  if (typeof floor === 'number') writeMeta(sqlite, CHANGES_FLOOR_KEY, String(floor));
  return computed;
}

/** Imports one collection, resuming from wherever it stopped. */
async function importCollection(
  session: ImportSession,
  plan: CollectionPlan,
  options: ImportOptions,
  ctx: MapContext,
): Promise<CollectionResult> {
  const { sqlite, mongo } = session;
  const checkpoint = readCheckpoint(sqlite, plan.source);
  if (checkpoint?.completed === true) {
    return {
      source: plan.source,
      documents: checkpoint.documents,
      rejected: checkpoint.rejected,
      elapsedMs: 0,
      skipped: true,
    };
  }

  const filter = await resolveFilter(sqlite, mongo, plan, options);
  const collection = mongo.collection(plan.source);
  const documentsTotal = await collection.countDocuments(filter);

  const writer = new RowWriter(sqlite);
  const startedAt = performance.now();
  let lastId = checkpoint?.lastId ?? null;
  let documents = checkpoint?.documents ?? 0;
  let rejected = checkpoint?.rejected ?? 0;
  const carriedMs = checkpoint?.elapsedMs ?? 0;

  try {
    for (;;) {
      const scoped: Filter<Document> =
        lastId === null ? filter : { $and: [filter, { _id: { $gt: lastId } }] };
      const docs = await collection
        .find(scoped, { sort: { _id: 1 }, limit: options.batchSize })
        .toArray();
      if (docs.length === 0) break;

      const mapped: MappedDocument[] = [];
      const mapFailures: Array<{ sourceId: string; reason: string }> = [];
      for (const doc of docs) {
        const record = doc as unknown as Record<string, unknown>;
        const sourceId = String(record._id);
        try {
          mapped.push({ sourceId, batches: plan.map(record, ctx) });
        } catch (err) {
          mapFailures.push({ sourceId, reason: errorMessage(err) });
        }
      }

      const batchLastId = (docs.at(-1) as unknown as Record<string, unknown>)._id;
      const batchDocuments = documents + docs.length;
      const elapsedSoFar = carriedMs + Math.round(performance.now() - startedAt);

      const writeFailures = writeBatch(sqlite, writer, mapped, (failures) => {
        for (const failure of [...mapFailures, ...failures]) {
          writeReject(sqlite, {
            source: plan.source,
            sourceId: failure.sourceId,
            reason: failure.reason,
          });
        }
        writeCheckpoint(sqlite, plan.source, plan.idKind, {
          lastId: batchLastId,
          documents: batchDocuments,
          rejected: rejected + mapFailures.length + failures.length,
          elapsedMs: elapsedSoFar,
          completed: false,
        });
      });

      lastId = batchLastId;
      documents = batchDocuments;
      rejected += mapFailures.length + writeFailures.length;
      options.onProgress?.({
        source: plan.source,
        documentsDone: documents,
        documentsTotal,
        rejected,
        elapsedMs: elapsedSoFar,
      });
    }
  } finally {
    writer.finalize();
  }

  const elapsedMs = carriedMs + Math.round(performance.now() - startedAt);
  sqlite.exec('BEGIN IMMEDIATE');
  writeCheckpoint(sqlite, plan.source, plan.idKind, {
    lastId,
    documents,
    rejected,
    elapsedMs,
    completed: true,
  });
  sqlite.exec('COMMIT');

  return { source: plan.source, documents, rejected, elapsedMs, skipped: false };
}

/** Drops the derived triggers for the bulk load. */
function dropDerivedTriggers(db: Database): void {
  for (const name of TRIGGER_NAMES) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}

/** Puts the triggers back and rebuilds everything they maintain. */
function restoreDerived(db: Database): void {
  db.exec(ASSET_LOCATIONS_TRIGGER_DDL);
  db.exec(ASSET_SEARCH_TRIGGER_DDL);
  db.exec(LIVE_LOCATION_COUNT_RECOMPUTE_SQL);
  // 'rebuild' discards the whole inverted index and re-derives it from the
  // content table, so it needs no clearing step and is safe to repeat.
  db.exec(ASSETS_FTS_REBUILD_SQL);
  db.exec(ASSETS_FTS_OPTIMIZE_SQL);
}

/**
 * Runs the whole import against an already-open session, so a caller that wants
 * to verify afterwards keeps the same handles.
 */
export async function runImportOn(
  session: ImportSession,
  options: ImportOptions,
): Promise<ImportReport> {
  const startedAt = performance.now();
  const substitutions: Record<string, number> = {};
  const unknownStages = new Set<string>();
  const ctx: MapContext = {
    stageNames: ALL_STAGE_NAMES,
    note(kind) {
      if (kind.startsWith('stage:')) unknownStages.add(kind.slice('stage:'.length));
      else substitutions[kind] = (substitutions[kind] ?? 0) + 1;
    },
  };

  dropDerivedTriggers(session.sqlite);

  const collections: CollectionResult[] = [];
  for (const plan of IMPORT_PLAN) {
    collections.push(await importCollection(session, plan, options, ctx));
  }

  // Repair first, while the triggers are still dropped: deleting a location
  // with the count triggers live would fire a per-row UPDATE on `assets` that
  // the recompute below redoes in one statement anyway.
  const repair = repairForeignKeys(session.sqlite);
  // Verification reads this back: a row dropped because a NOT NULL reference
  // did not resolve is a row the source counted and the destination correctly
  // does not hold, so the count check has to know about it.
  writeMeta(session.sqlite, REPAIR_META_KEY, JSON.stringify(repair));
  restoreDerived(session.sqlite);

  const floor = readMeta(session.sqlite, CHANGES_FLOOR_KEY);
  return {
    collections,
    rejects: readRejects(session.sqlite),
    danglingNulled: repair.nulled,
    danglingDropped: repair.dropped,
    substitutions,
    unknownStages: [...unknownStages].sort(),
    changesCursorFloor: floor === null ? null : Number(floor),
    totalElapsedMs: Math.round(performance.now() - startedAt),
  };
}

/** Opens a session, imports, and closes it. */
export async function runImport(options: ImportOptions): Promise<ImportReport> {
  const session = await openImportSession(options);
  try {
    return await runImportOn(session, options);
  } finally {
    await closeImportSession(session);
  }
}

/** Re-exported so a caller can confirm the destination is clean. */
export { foreignKeyViolations };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
