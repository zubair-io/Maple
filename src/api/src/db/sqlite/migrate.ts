/**
 * Boot-time migration gate for the SQLite backend — the engine-agnostic
 * successor to `db/migrations.ts`.
 *
 * The sentinel table `schema_migrations` records one row per migration id that
 * has been applied to this database file, so a boot that has already migrated
 * short-circuits instead of re-running DDL. Same contract as the Mongo
 * `migrations` collection it replaces, and for the same reason: the id lives in
 * the primary key, so `SELECT * FROM schema_migrations` is the operator answer
 * to "what has been applied to this library?".
 *
 * Two things improve over the Mongo runner:
 *
 *  1. **Atomicity.** SQLite runs DDL inside transactions, so a migration and
 *     its sentinel row commit together. The Mongo runner had to accept a rare
 *     double-run when the process died between the backfill and the sentinel
 *     insert; here that window does not exist.
 *  2. **Concurrency.** `BEGIN IMMEDIATE` takes the write lock up front, so two
 *     processes booting against the same file serialise. The loser re-reads the
 *     sentinel inside its own transaction and skips, rather than racing into a
 *     duplicate-key error it has to swallow.
 *
 * Connection management is deliberately NOT this module's business. The runner
 * talks to a {@link MigrationDb} — three methods a `bun:sqlite` `Database`
 * satisfies directly (see {@link fromBunSqlite}) and the worker-backed pool can
 * satisfy with its read / write / transaction primitives. The only requirement
 * is that every call lands on the same connection, with writes serialised;
 * anything else would make `BEGIN` meaningless.
 */

/** Value types SQLite can bind. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

/**
 * The slice of a SQLite connection the runner needs. Methods may be sync or
 * async — the runner awaits either — so a direct `bun:sqlite` handle and an
 * async pool client both fit without an adapter layer in between.
 */
export interface MigrationDb {
  /** Runs one or more statements with no bound parameters. Used for DDL. */
  exec(sql: string): void | Promise<void>;
  /** Runs a single parameterised statement. */
  run(sql: string, params?: readonly SqlValue[]): void | Promise<void>;
  /** Runs a single parameterised query and returns every row. */
  all<T>(sql: string, params?: readonly SqlValue[]): T[] | Promise<T[]>;
}

/**
 * One schema change. `id` is the durable name recorded in the sentinel table —
 * once a migration has shipped, its id is frozen, because live databases carry
 * it. The convention is `NNNN-kebab-summary`, zero-padded so lexical order and
 * apply order agree; {@link assertMigrationOrder} enforces that they do.
 *
 * **What it does is frozen too, and nothing here can enforce that.** A database
 * that has recorded an id skips that migration forever, on the id alone, so
 * editing a shipped migration changes what NEW installs get and leaves every
 * existing one behind, with no error anywhere. Once a migration has run
 * somewhere real, a change to the schema is a new migration.
 *
 * Before that — while the only databases carrying `0001` are development files
 * and CI's, both disposable — editing in place is the right move and beats
 * shipping a corrective `0002` that every future install would run for no
 * reason. That is deliberate rather than accidental: the cost is deleting a
 * scratch database.
 */
export interface Migration {
  id: string;
  up(db: MigrationDb): void | Promise<void>;
}

/** One row of the sentinel table. */
export interface AppliedMigration {
  id: string;
  applied_at: string;
  duration_ms: number;
}

/** What {@link runMigrations} did. */
export interface MigrationRunResult {
  /** Ids applied by THIS call, in the order they ran. */
  applied: string[];
  /** Ids that were already recorded and were skipped. */
  skipped: string[];
  /** Wall-clock milliseconds per applied id. */
  durations: Record<string, number>;
}

export const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations';

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
  id           TEXT    NOT NULL PRIMARY KEY,
  applied_at   TEXT    NOT NULL,
  duration_ms  INTEGER NOT NULL
) WITHOUT ROWID;
`;

/**
 * Creates the sentinel table when it is absent. Safe to call on every boot and
 * against a database that has never been touched.
 */
async function ensureMigrationsTable(db: MigrationDb): Promise<void> {
  await db.exec(SCHEMA_MIGRATIONS_DDL);
}

/** Every recorded migration, oldest first. The operator-facing read. */
export async function appliedMigrations(db: MigrationDb): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(db);
  return await db.all<AppliedMigration>(
    `SELECT id, applied_at, duration_ms FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY id`,
  );
}

/** True when `id` has been applied to this database. */
export async function migrationApplied(db: MigrationDb, id: string): Promise<boolean> {
  await ensureMigrationsTable(db);
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
    [id],
  );
  return rows.length > 0;
}

/**
 * The migrations in `migrations` that this database has not recorded yet, in
 * declaration order.
 */
export async function pendingMigrations(
  db: MigrationDb,
  migrations: readonly Migration[],
): Promise<Migration[]> {
  assertMigrationOrder(migrations);
  await ensureMigrationsTable(db);
  const rows = await db.all<{ id: string }>(`SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE}`);
  const done = new Set(rows.map((row) => row.id));
  return migrations.filter((migration) => !done.has(migration.id));
}

/**
 * Rejects a migration list whose ids are duplicated or out of lexical order.
 *
 * The check exists because the failure it catches is silent and permanent: a
 * migration inserted above an id that has already shipped never runs on a
 * database that recorded the later id, and the two installs diverge with no
 * error anywhere. Lexical order is what makes "everything after the last
 * recorded id" a well-defined set.
 */
export function assertMigrationOrder(migrations: readonly Migration[]): void {
  const seen = new Set<string>();
  let previous = '';
  for (const migration of migrations) {
    if (migration.id.length === 0) {
      throw new Error('migration id must not be empty');
    }
    if (seen.has(migration.id)) {
      throw new Error(`duplicate migration id: ${migration.id}`);
    }
    if (migration.id <= previous) {
      throw new Error(
        `migration ids must be declared in ascending order: ${migration.id} follows ${previous}`,
      );
    }
    seen.add(migration.id);
    previous = migration.id;
  }
}

/**
 * Applies every pending migration in order, each inside its own transaction
 * together with its sentinel row.
 *
 * Idempotent, and cheaply so: the already-applied ids are read once, up front,
 * and a boot with nothing to do takes no write lock at all. That is the point
 * of reading the sentinel table before the loop rather than inside it — this
 * repository boots three process roles against one file, so a per-migration
 * `BEGIN IMMEDIATE` on the common no-op path would cost one exclusive lock and
 * one fsync per migration per role, serialised against each other, for nothing.
 *
 * Still safe to call concurrently: the id list is re-checked inside the write
 * lock, because another process may have applied a migration between the read
 * above and this one acquiring the lock. The loser finds the sentinel and
 * skips, rather than racing into a duplicate-key error it has to swallow.
 *
 * A migration that throws rolls back and the error propagates with the
 * offending id attached; nothing after it runs, and nothing it did survives.
 * `BEGIN IMMEDIATE` is inside the same guard, so a lock-contention failure
 * ("database is locked", when the connection owner set no `busy_timeout` or
 * the other role's migration outran it) also names the migration it was
 * waiting for instead of arriving bare.
 */
export async function runMigrations(
  db: MigrationDb,
  migrations: readonly Migration[],
): Promise<MigrationRunResult> {
  const pending = await pendingMigrations(db, migrations);
  const pendingIds = new Set(pending.map((migration) => migration.id));

  const applied: string[] = [];
  const skipped = migrations
    .filter((migration) => !pendingIds.has(migration.id))
    .map((migration) => migration.id);
  const durations: Record<string, number> = {};

  for (const migration of pending) {
    const startedAt = performance.now();
    try {
      await db.exec('BEGIN IMMEDIATE');
      // Re-read inside the write lock: another process may have applied this
      // migration between our pending check and our acquiring the lock.
      const rows = await db.all<{ id: string }>(
        `SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
        [migration.id],
      );
      if (rows.length > 0) {
        await db.exec('COMMIT');
        skipped.push(migration.id);
        continue;
      }
      await migration.up(db);
      const elapsed = Math.round(performance.now() - startedAt);
      await db.run(
        `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (id, applied_at, duration_ms) VALUES (?, ?, ?)`,
        [migration.id, new Date().toISOString(), elapsed],
      );
      await db.exec('COMMIT');
      applied.push(migration.id);
      durations[migration.id] = elapsed;
    } catch (err) {
      await rollbackQuietly(db);
      throw new Error(`migration ${migration.id} failed: ${errorMessage(err)}`, { cause: err });
    }
  }

  return { applied, skipped, durations };
}

/**
 * Rolls back without masking the original failure. A `ROLLBACK` can itself
 * throw when the transaction is already gone (SQLite auto-rolls-back on some
 * errors); that secondary error is noise next to the one we are about to
 * rethrow.
 */
async function rollbackQuietly(db: MigrationDb): Promise<void> {
  try {
    await db.exec('ROLLBACK');
  } catch {
    // Intentionally ignored — see the doc comment.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The shape of `bun:sqlite`'s `Database` that {@link fromBunSqlite} needs.
 *
 * `run` takes its bindings as a single array rather than a variadic list —
 * `bun:sqlite` accepts both at runtime, but only the array form type-checks
 * against its declared `run<P extends SQLQueryBindings[]>(sql, ...bindings: P[])`.
 */
export interface BunSqliteLike {
  exec(sql: string): unknown;
  run(sql: string, params: SqlValue[]): unknown;
  query(sql: string): { all(...params: SqlValue[]): unknown[] };
}

/**
 * Adapts a synchronous `bun:sqlite` handle to {@link MigrationDb}.
 *
 * Correct for the importer, the benchmarks and the tests, all of which own the
 * connection outright and have no event loop to protect. The API process must
 * NOT use this — every in-process SQLite call blocks Bun's event loop, which is
 * why the runtime goes through the worker-backed pool instead.
 */
export function fromBunSqlite(db: BunSqliteLike): MigrationDb {
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    run: (sql, params = []) => {
      db.run(sql, [...params]);
    },
    all: <T>(sql: string, params: readonly SqlValue[] = []) => db.query(sql).all(...params) as T[],
  };
}
