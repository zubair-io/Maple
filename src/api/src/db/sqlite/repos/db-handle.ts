/**
 * How a ported repository reaches SQLite, and what a write reports back.
 *
 * Two small things live here, and both exist to keep the repository modules
 * from growing their own opinions about either.
 *
 * **The handle.** {@link SqliteDb} is the three primitives the worker-backed
 * pool exposes — read, write, transaction — and nothing else. `SqlitePool`
 * satisfies it structurally, so production code passes no handle at all and
 * {@link assetsDb} reaches the process-wide pool, exactly the way the Mongo
 * repo reaches `assetsCollection()` today. The optional override is what tests
 * use, and it is the same override parameter the Mongo repo already had; the
 * only difference is the type it accepts.
 *
 * Production code on the request path must go through the pool. Every
 * in-process SQLite call blocks Bun's event loop, so a repository that reached
 * for `bun:sqlite` directly would stall every concurrent request for the
 * duration of its query. See `../pool.ts` for the measurements.
 *
 * **The write outcomes.** The Mongo repo returns driver result objects, and
 * routes read `matchedCount` / `deletedCount` off them. {@link UpdateOutcome}
 * and {@link DeleteOutcome} carry the same fields with the same meanings, so
 * the cutover (#3752) swaps an import rather than rewriting call sites; the
 * assignability is pinned by a test rather than asserted here.
 */

import { sqlitePool } from '../index.ts';
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
 * Throws when neither exists, which is the same failure the Mongo repo has
 * when the client was never connected: a programming error at startup, not a
 * condition a request handler can recover from.
 */
export function assetsDb(dbOverride?: SqliteDb): SqliteDb {
  return dbOverride ?? sqlitePool();
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
  return dbOverride ?? sqlitePool();
}

/**
 * What an update reports, shaped like the driver's `UpdateResult` so callers
 * that read `matchedCount` keep compiling.
 *
 * `matchedCount` and `modifiedCount` are always equal here, and that is a real
 * difference worth knowing about: MongoDB distinguishes "the filter matched a
 * document" from "the document's bytes actually changed", while SQLite's
 * `changes()` counts every row the statement touched whether or not the new
 * value differs from the old. Every call site in this repository's routes
 * branches on `matchedCount === 0` ("no such asset"), which both engines answer
 * identically.
 *
 * `upsertedId` is always null: nothing in this repository upserts through a
 * filter, so there is never a generated id to report.
 */
export interface UpdateOutcome {
  acknowledged: boolean;
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
  upsertedId: null;
}

/** What a delete reports, shaped like the driver's `DeleteResult`. */
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
