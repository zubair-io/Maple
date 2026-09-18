/**
 * The shared SQLite test harness: one database per test, schema applied,
 * disposed when the test ends (#3745).
 *
 * This is the SQLite-era counterpart to `db/test-db.test-helpers.ts`, and it
 * exists as one file for the same reason that one did — the cross-test
 * pollution the Mongo suite spent #2491 and #2783 chasing started because each
 * file invented its own setup. There is exactly one way to get a database here,
 * and it is isolated by construction.
 *
 * Three properties the Mongo harness could only approximate:
 *
 *  1. **Per test, not per suite.** `withTestDb` could only name a database for
 *     a whole file, so every test in that file shared one namespace and had to
 *     avoid colliding with its neighbours' fixtures. Creating a database costs
 *     single-digit milliseconds here, so each test gets its own and two tests
 *     can insert the same primary key without knowing about each other.
 *  2. **Disposal that survives a failure.** A handle is `Disposable`, so
 *     `using handle = await createTestDatabase()` closes it when the block
 *     exits — including when an assertion throws, which is precisely when the
 *     old `db.close()` on the last line of a test did not run.
 *  3. **No external service.** Nothing to install, nothing to leave running,
 *     nothing that can be left holding another agent's data.
 *
 * `bun:sqlite` is used directly and deliberately: a test owns its connection
 * outright and has no event loop to protect, which is the same reasoning the
 * importer and the benchmarks follow. The worker-backed pool exists to keep
 * the API process's event loop free and is not a dependency of this file.
 */

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_PRAGMAS } from './ddl/index.ts';
import { fromBunSqlite, runMigrations, type MigrationDb } from './migrate.ts';
import { ALL_MIGRATIONS } from './migrations/index.ts';
import { newObjectIdHex } from './object-id.ts';
// `SqlValue` is declared identically by `migrate.ts` and `protocol.ts` — the
// migration runner keeps its own copy so it depends on no pool type. This file
// needs both modules, so it takes the name from one of them rather than
// importing an ambiguous pair.
import type { SqlParams, SqlRow, SqlStatement, SqlValue, SqlWriteResult } from './protocol.ts';
import type { SqliteDb } from './repos/db-handle.ts';

/**
 * Where a test database lives.
 *
 * `memory` is the default and the right answer for almost every test: it is
 * the fastest, and an in-memory database is private to the connection that
 * opened it, so isolation is a property of SQLite rather than of this file.
 *
 * `file` exists for the cases an in-memory database cannot express — anything
 * that needs a second connection to the same database, or that asserts on what
 * is actually on disk. It is also the mode where isolation has to be *earned*,
 * because two tests naming the same path would share a database; see
 * {@link makeDirectory} for how that is prevented.
 */
export type TestStorage = 'memory' | 'file';

/** An open test database and the views onto it a test needs. */
export interface TestDatabase extends Disposable {
  /** The connection. Synchronous, owned by this test, safe to use directly. */
  readonly db: Database;
  /** The same connection as the migration runner sees it. */
  readonly migrationDb: MigrationDb;
  /** The database file for `file` storage, `':memory:'` otherwise. */
  readonly path: string;
  /**
   * Closes the connection and removes the file, if any. Idempotent, so an
   * explicit call inside a test and the automatic `using` disposal can both
   * fire without the second one throwing.
   */
  close(): void;
}

/**
 * Directories created by {@link makeDirectory} that have not been removed yet.
 *
 * The backstop for a handle that never gets disposed — a test that forgets
 * `using`, or a file that dies partway through. #2491 measured 11,375 leaked
 * Mongo test databases accumulated exactly this way, from suites that were each
 * individually expected to clean up after themselves. Temp directories are
 * cheaper to leak than databases on a shared server, but the lesson is the
 * same: the cleanup belongs to the harness, not to every caller's good manners.
 *
 * Only paths this module minted via `mkdtemp` are ever in here, so the exit
 * sweep cannot reach anything it did not create.
 */
const liveDirectories = new Set<string>();

let sweepHooksInstalled = false;

/** Removes every directory still on the books. Idempotent. */
function sweep(): void {
  for (const directory of liveDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  liveDirectories.clear();
}

/**
 * Registers the leak sweep, once, on first use of `file` storage.
 *
 * Deliberately lazy rather than a module-level side effect: a suite that only
 * ever opens in-memory databases has nothing to sweep and should not be
 * installing process listeners just by importing this file.
 *
 * `exit` alone is not enough. It does not run for a process killed by a
 * signal, and Ctrl-C on a run that is hung — which is exactly when a test is
 * most likely to be holding an undisposed handle — is the ordinary way that
 * happens. So SIGINT and SIGTERM sweep too, then re-exit with the status a
 * shell expects from a signal death (128 + signal number) rather than
 * swallowing the interrupt. SIGKILL and a hard crash remain unreachable by
 * construction; the remaining residue there is one small directory per run.
 */
function installSweepHooks(): void {
  if (sweepHooksInstalled) return;
  sweepHooksInstalled = true;
  process.on('exit', sweep);
  for (const [signal, status] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    process.on(signal, () => {
      sweep();
      process.exit(status);
    });
  }
}

/**
 * Mints a private directory for one file-backed database.
 *
 * `mkdtemp` is what makes `file` storage parallel-safe, and it is load-bearing
 * in two directions at once. Within a process, concurrent tests each get a
 * distinct name with no shared counter to race on. Across processes — two CI
 * shards, or two agents running the suite in separate worktrees — the random
 * suffix means neither has to know the other exists. A naming scheme built
 * from the pid, or from a module-level counter, would satisfy one of those and
 * quietly fail the other.
 *
 * One directory per database rather than one file, so the `-wal` and `-shm`
 * sidecars WAL mode creates go away with it.
 */
function makeDirectory(): string {
  installSweepHooks();
  const directory = mkdtempSync(join(tmpdir(), 'maple-api-testdb-'));
  liveDirectories.add(directory);
  return directory;
}

function makeHandle(db: Database, path: string, directory: string | null): TestDatabase {
  let closed = false;
  const close = (): void => {
    if (closed) return;
    // Removing the directory is in a `finally` and `closed` is set last, so a
    // connection that refuses to close still gives up its files: otherwise the
    // one case where cleanup matters most — something went wrong — is the case
    // that leaks, and the handle could not even be closed a second time,
    // because the early return above would have swallowed the retry.
    try {
      db.close();
    } finally {
      if (directory !== null) {
        rmSync(directory, { recursive: true, force: true });
        liveDirectories.delete(directory);
      }
    }
    closed = true;
  };

  return { db, migrationDb: fromBunSqlite(db), path, close, [Symbol.dispose]: close };
}

/**
 * A database with the schema's pragmas applied and nothing else in it.
 *
 * For tests of the migration runner itself, which need to observe a database
 * from before any migration ran. Everything else wants
 * {@link createTestDatabase}.
 */
export function createBlankTestDatabase(storage: TestStorage = 'memory'): TestDatabase {
  const directory = storage === 'file' ? makeDirectory() : null;
  const path = directory === null ? ':memory:' : join(directory, 'maple.sqlite');
  const db = new Database(path);
  for (const pragma of SCHEMA_PRAGMAS) {
    // WAL is a no-op on an in-memory database; the rest apply normally.
    db.exec(pragma);
  }
  return makeHandle(db, path, directory);
}

/**
 * A database with the full schema applied — the one a test wants.
 *
 * ```ts
 * test('rejects a duplicate filename', async () => {
 *   using handle = await createTestDatabase();
 *   const db = handle.db;
 *   // …
 * });
 * ```
 *
 * `using` is what makes disposal unconditional: the handle closes when the
 * block exits, so a failing assertion cannot skip the cleanup the way a
 * trailing `db.close()` does. Tests written with `using` are also safe under
 * `test.concurrent`, because the handle is a local binding and this module
 * keeps no notion of a "current" database that two tests could fight over.
 *
 * A migration that fails closes the handle before rethrowing, so a broken
 * schema does not leave a file behind on top of failing the test.
 */
export async function createTestDatabase(storage: TestStorage = 'memory'): Promise<TestDatabase> {
  const handle = createBlankTestDatabase(storage);
  try {
    await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  } catch (err) {
    handle.close();
    throw err;
  }
  return handle;
}

/**
 * `db.run` with the parameter list as an array.
 *
 * `bun:sqlite` accepts both a variadic list and a single array at runtime, but
 * only the array form type-checks against its declared
 * `run<P extends SQLQueryBindings[]>(sql, ...bindings: P[])`. Wrapping it once
 * keeps every call site readable.
 */
export function run(db: Database, sql: string, ...params: SqlValue[]): void {
  db.run(sql, params);
}

/** Normalise bound parameters to the varargs shape `bun:sqlite` expects. */
function bindings(params: SqlParams | undefined): never[] {
  if (params === undefined) return [];
  return (Array.isArray(params) ? [...params] : [params]) as never[];
}

function exec(db: Database, statement: SqlStatement): SqlWriteResult {
  const result = db.prepare(statement.sql).run(...bindings(statement.params));
  return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
}

/**
 * Adapts a synchronous `bun:sqlite` handle to the three primitives a repository
 * uses, so a repository function can be driven against a test's own connection.
 *
 * `bun:sqlite` is used directly here for the same reason
 * {@link createTestDatabase} does — a test owns its connection outright and has
 * no event loop to protect. The worker-backed pool exists to keep the API
 * process responsive and cannot back an in-memory database anyway, since each
 * pool worker opens the file by path. Production code must never reach for this
 * adapter; that is what `sqliteDb()` and the pool are for.
 *
 * The transaction wrapper mirrors the database worker's: `BEGIN IMMEDIATE`,
 * then a rollback that never masks the original error. What it cannot mirror is
 * interleaving — a synchronous connection runs each batch start to finish
 * inside one microtask, so a test that needs two callers to genuinely race has
 * to open the real pool against a file-backed database instead.
 */
export function testSqliteDb(db: Database): SqliteDb {
  return {
    read: async <T = SqlRow>(sql: string, params?: SqlParams): Promise<T[]> =>
      db.query(sql).all(...bindings(params)) as T[],
    write: async (sql: string, params?: SqlParams) => exec(db, { sql, params }),
    transaction: async (statements: readonly SqlStatement[]) => {
      db.run('BEGIN IMMEDIATE');
      const results: SqlWriteResult[] = [];
      try {
        for (const statement of statements) results.push(exec(db, statement));
        db.run('COMMIT');
      } catch (e) {
        try {
          db.run('ROLLBACK');
        } catch {
          // Already unwound by SQLite; the caller's error is the one to report.
        }
        throw e;
      }
      return results;
    },
  };
}

/** Inserts a library root and returns its id. */
export function insertFolder(
  db: Database,
  overrides: { path?: string; slug?: string } = {},
): string {
  const id = newObjectIdHex();
  const path = overrides.path ?? `/libraries/${id}`;
  const slug = overrides.slug ?? `lib-${id.slice(-6)}`;
  run(
    db,
    `INSERT INTO folders (id, path, slug, label, file_count, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    id,
    path,
    slug,
    'Test library',
    new Date().toISOString(),
  );
  return id;
}

/** Inserts a minimal asset row and returns its id. */
export function insertAsset(
  db: Database,
  overrides: {
    id?: string;
    exif?: string | null;
    place?: string | null;
    deletedAt?: string | null;
  } = {},
): string {
  const id = overrides.id ?? newObjectIdHex();
  run(
    db,
    `INSERT INTO assets (id, size, mtime, indexed_at, exif, place, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    1024,
    Date.now(),
    new Date().toISOString(),
    overrides.exif ?? null,
    overrides.place ?? null,
    overrides.deletedAt ?? null,
  );
  return id;
}

/** Inserts one location for an asset. */
export function insertLocation(
  db: Database,
  args: {
    assetId: string;
    libraryId: string;
    ordinal?: number;
    path?: string;
    filename?: string;
    deletedAt?: string | null;
    missingSince?: string | null;
  },
): void {
  run(
    db,
    `INSERT INTO asset_locations
       (asset_id, ordinal, library_id, path, filename, deleted_at, missing_since)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args.assetId,
    args.ordinal ?? 0,
    args.libraryId,
    args.path ?? 'vacation/2024',
    args.filename ?? `${args.assetId}.dng`,
    args.deletedAt ?? null,
    args.missingSince ?? null,
  );
}

/** Reads one asset's `live_location_count`. */
export function liveLocationCount(db: Database, assetId: string): number {
  const row = db.query(`SELECT live_location_count AS n FROM assets WHERE id = ?`).get(assetId) as {
    n: number;
  } | null;
  return row?.n ?? -1;
}
