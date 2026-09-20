/**
 * The schema gate, run at boot: bring the database file up to date, then serve.
 *
 * ## What happens on every boot
 *
 *  1. The API process resolves `MAPLE_SQLITE_PATH` and creates the directory
 *     holding it if it is not there.
 *  2. It opens the file — creating it when absent — and applies whatever
 *     migrations the file has not recorded yet.
 *  3. Only then does the caller open the pool, spawn the worker child and start
 *     listening.
 *
 * On an install that is already current, step 2 reads one table and does
 * nothing; on a brand-new install it writes the whole schema and the server
 * comes up with an empty library, which the indexer then fills from the
 * configured roots. Both are ordinary outcomes and neither needs an operator.
 *
 * ## Why this runs here rather than nowhere
 *
 * Until #3785 the migration list was only ever executed by the MongoDB
 * importer, because every database that existed had been through it. Deleting
 * the importer without putting the runner somewhere would have meant the next
 * schema change never applied to any live library — the failure would have been
 * silent, and it would have surfaced as a query against a column that was never
 * added. This is the module that closes that gap, and it is why the runner
 * itself (`migrate.ts` and `migrations/`) is not part of what the MongoDB
 * removal deletes: the schema's own versioning has nothing to do with the
 * engine it was ported off.
 *
 * ## Why a failure here stops the boot
 *
 * Every other phase of this server's boot logs its failure and continues,
 * because a degraded subsystem is better than no server. This one is the
 * exception, and it is a narrower exception than the one it replaces. The old
 * boot refused to serve an *unmigrated* database, because a half-imported
 * library is indistinguishable over the API from a library whose files have
 * been deleted: the File Provider clients would see every item vanish and act
 * on it. With no import step there is nothing to half-finish, so an empty
 * database is now simply a new install and is served.
 *
 * What still stops the boot is a migration that *fails*. The schema is then
 * some unknown fraction of the way through a change the code above it already
 * assumes, and a server that keeps going in that state writes into a shape it
 * cannot trust. Each migration commits with its own sentinel row inside one
 * transaction, so nothing a failed migration did survives and a restart retries
 * it cleanly.
 *
 * ## Foreign keys are deliberately off while this runs
 *
 * `PRAGMA foreign_keys` defaults to off and this module leaves it there, which
 * is what SQLite asks of anything changing a schema: the table-rebuild pattern
 * a column change needs moves rows between a table and its replacement, and an
 * enforced constraint mid-rebuild rejects the intermediate state. The pool's
 * writer turns enforcement on for the connection that actually serves, so the
 * running server has it and the migration does not — the same split the
 * importer used when it ran this list.
 */

import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { child as childLogger } from '../../log.ts';
import {
  DEFAULT_SQLITE_PATH,
  sqliteDatabasePath,
  sqliteDatabasePathIsDefault,
} from './database-path.ts';
import { fromBunSqlite, runMigrations } from './migrate.ts';
import { ALL_MIGRATIONS } from './migrations/index.ts';

export { sqliteDatabasePath } from './database-path.ts';

const log = childLogger('sqlite:schema');

/**
 * Pragmas set before the migrations run.
 *
 * WAL is a persistent property of the file, so setting it on the connection
 * that creates the database means a fresh install is in WAL mode from its first
 * write rather than from whenever the pool's writer first opens it. The busy
 * timeout covers the case where two process roles boot against one file at
 * once: the loser of `BEGIN IMMEDIATE` waits rather than failing.
 *
 * `foreign_keys` is absent on purpose — see the module header.
 */
const MIGRATION_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA synchronous = NORMAL',
] as const;

/** What one call to {@link ensureSchemaAtBoot} did. */
export interface SchemaBootOutcome {
  /** The file this ran against. */
  path: string;
  /** Migration ids applied by this boot, in the order they ran. */
  applied: string[];
  /** True when the database did not exist before this call. */
  created: boolean;
}

/** Raised when the boot must not proceed to serving. */
export class SchemaBootError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SchemaBootError';
  }
}

/**
 * Brings the database at `MAPLE_SQLITE_PATH` up to the current schema, creating
 * it if this is a first boot. Throws {@link SchemaBootError} if it cannot.
 *
 * The caller must not open the pool, spawn the worker tier or start listening
 * until this resolves.
 */
export async function ensureSchemaAtBoot(): Promise<SchemaBootOutcome> {
  const path = sqliteDatabasePath();
  const created = !(await Bun.file(path).exists());

  await mkdir(dirname(path), { recursive: true }).catch((cause: unknown) => {
    throw new SchemaBootError(
      `cannot create the directory for the library database at ${path}. ` +
        'Check MAPLE_SQLITE_PATH and the permissions on its parent directory.',
      { cause },
    );
  });

  const db = openForMigration(path);
  try {
    const result = await runMigrations(fromBunSqlite(db), ALL_MIGRATIONS);
    if (created && sqliteDatabasePathIsDefault()) {
      // The one combination that can destroy a library without erroring: a
      // first boot on the relative default. In a container that path is inside
      // the container, so the library it creates is thrown away with it on the
      // next recreate, and the boot after that creates another empty one — an
      // operator sees a working server with no photos and no failure to chase.
      // Bare metal reaches this line too and is fine; the warning names the
      // container case rather than guessing which one this is.
      log.warn(
        { path, variable: 'MAPLE_SQLITE_PATH', default: DEFAULT_SQLITE_PATH },
        'created a new, empty library at the built-in default path because MAPLE_SQLITE_PATH is ' +
          'unset. That path is relative, so in a container it resolves inside the container and ' +
          'this library will be lost on the next recreate, silently. If this server is containerised, ' +
          'stop it now, set MAPLE_SQLITE_PATH to an absolute path on a mounted volume, and restart.',
      );
    } else if (created) {
      log.info({ path, applied: result.applied }, 'new library database created');
    } else if (result.applied.length > 0) {
      log.info({ path, applied: result.applied }, 'schema migrations applied');
    } else {
      log.info({ path }, 'schema up to date');
    }
    return { path, applied: result.applied, created };
  } catch (err) {
    throw new SchemaBootError(
      `the library database at ${path} could not be brought up to the current schema. ` +
        'The server will not serve a database whose shape it cannot trust. Nothing the failed ' +
        'migration did survives, so restarting retries it.',
      { cause: err },
    );
  } finally {
    db.close();
  }
}

/**
 * Opens the file read-write, creating it when absent, with the pragmas above.
 *
 * Synchronous `bun:sqlite` rather than the pool: this runs before the pool
 * exists, there is no event loop to protect yet, and `BEGIN IMMEDIATE` only
 * means anything when every statement lands on one connection.
 */
function openForMigration(path: string): Database {
  const db = (() => {
    try {
      return new Database(path, { create: true, readwrite: true });
    } catch (cause) {
      throw new SchemaBootError(
        `the library database at ${path} could not be opened. Check MAPLE_SQLITE_PATH, the ` +
          'permissions on the file, and that it is not on a filesystem that cannot hold one.',
        { cause },
      );
    }
  })();
  for (const pragma of MIGRATION_PRAGMAS) db.exec(pragma);
  return db;
}
