/**
 * How a repository reaches SQLite, and what a write reports back.
 *
 * Two small things live here, and both exist to keep the repository modules
 * from growing their own opinions about either.
 *
 * **The handle.** {@link SqliteDb} is the three primitives the worker-backed
 * pool exposes — read, write, transaction — and nothing else. `SqlitePool`
 * satisfies it structurally, so production code passes no handle at all and
 * {@link sqliteDb} reaches the process-wide handle. The optional override is
 * what tests use.
 *
 * Production code on the request path must go through the pool. Every
 * in-process SQLite call blocks Bun's event loop, so a repository that reached
 * for `bun:sqlite` directly would stall every concurrent request for the
 * duration of its query. See `../pool.ts` for the measurements.
 *
 * **The write outcomes.** {@link UpdateOutcome} and {@link DeleteOutcome} carry
 * `matchedCount`, `modifiedCount` and `deletedCount`, which is what routes
 * branch on. The names are the MongoDB driver's, kept when the repositories
 * were ported (#3746–#3751) so the cutover could swap an import rather than
 * rewrite forty call sites. They are now simply this repository's vocabulary
 * for what a write touched; nothing else remains of the driver.
 */

import { processSqliteHandle } from '../index.ts';
import type { SqlParams, SqlRow, SqlStatement, SqlWriteResult } from '../protocol.ts';

/**
 * The slice of a SQLite connection a repository needs: the pool's three
 * primitives, unchanged.
 *
 * Deliberately not an abstraction over "a database" — there is one
 * implementation in production (the pool) and one in tests (a `bun:sqlite`
 * handle a test owns outright). It exists because a test cannot use the pool:
 * the pool spawns worker threads against a file, and a per-test database is
 * an in-memory connection.
 */
export interface SqliteDb {
  read<T = SqlRow>(sql: string, params?: SqlParams): Promise<T[]>;
  write(sql: string, params?: SqlParams): Promise<SqlWriteResult>;
  transaction(statements: readonly SqlStatement[]): Promise<SqlWriteResult[]>;
}

/**
 * The handle a repository function should use: the caller's override when it
 * supplied one, otherwise the process-wide pool.
 *
 * Throws when neither exists. That is a programming error at startup — the
 * process never opened its pool — not a condition a request handler can
 * recover from.
 */
export function assetsDb(dbOverride?: SqliteDb): SqliteDb {
  return sqliteDb(dbOverride);
}

/**
 * {@link assetsDb} under a name that does not claim a table.
 *
 * The remaining-collections port (#3751) needs the same "override, else the
 * process-wide pool" resolution for `folders`, `users`, `imports` and the
 * couple of dozen other tables it covers, and `assetsDb()` inside a folders
 * repository reads as a mistake even though it does the right thing.
 */
export function sqliteDb(dbOverride?: SqliteDb): SqliteDb {
  return dbOverride ?? processSqliteHandle();
}

/**
 * The same resolution for the people and faces repositories (#3749).
 *
 * A separate name rather than a shared `db()` because the call sites read as
 * prose — `peopleDb(dbOverride)` in a people repo, `assetsDb(dbOverride)` in an
 * assets one — and because a repository that reached for the other domain's
 * accessor would then look wrong at a glance.
 */
export function peopleDb(dbOverride?: SqliteDb): SqliteDb {
  return dbOverride ?? processSqliteHandle();
}

/**
 * What an update reports.
 *
 * `matchedCount` and `modifiedCount` are always equal, which is worth knowing
 * if you are reading a call site that treats them as distinct: SQLite's
 * `changes()` counts every row the statement touched, whether or not the new
 * value differs from the old. Nothing here branches on the difference — every
 * caller asks `matchedCount === 0`, meaning "no such asset".
 *
 * `upsertedId` is always null: nothing in this repository upserts through a
 * filter, so there is never a generated id to report. It is kept because the
 * shape is what the routes were written against.
 */
export interface UpdateOutcome {
  acknowledged: boolean;
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
  upsertedId: null;
}

/** What a delete reports. */
export interface DeleteOutcome {
  acknowledged: boolean;
  deletedCount: number;
}

/** Wraps a statement's row count as an {@link UpdateOutcome}. */
export function updateOutcome(changes: number): UpdateOutcome {
  return {
    acknowledged: true,
    matchedCount: changes,
    modifiedCount: changes,
    upsertedCount: 0,
    upsertedId: null,
  };
}

/** Wraps a statement's row count as a {@link DeleteOutcome}. */
export function deleteOutcome(changes: number): DeleteOutcome {
  return { acknowledged: true, deletedCount: changes };
}

/** The row count of the statement at `index` in a transaction's results. */
export function changesAt(results: readonly SqlWriteResult[], index: number): number {
  return results[index]?.changes ?? 0;
}

/**
 * A row count as "did the statement match its one row", which is the only
 * thing a by-id update can honestly report.
 *
 * `bun:sqlite` counts every row a statement wrote, including rows written by
 * triggers and by cascading deletes — `hardDelete` has said so since the
 * cutover, where a ten-location asset deletes as sixteen. Since #3768 an
 * update that changes `assets.deleted_at`, `assets.hidden` or
 * `live_location_count` fans out to four satellite tables as well
 * (`ddl/facet-state.ts`), so the raw count on those statements is the asset
 * plus however many locations, faces, subjects and detail rows it has.
 *
 * Every caller of `matchedCount` asks whether it is zero, meaning "no such
 * asset" — which is what Mongo's `updateOne` on `{ _id }` reported, and what
 * this preserves.
 */
export function matchedOne(changes: number): number {
  return changes > 0 ? 1 : 0;
}
