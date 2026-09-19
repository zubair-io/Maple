/**
 * The cutover, run at boot: migrate from MongoDB once, then serve on SQLite
 * (#3752).
 *
 * ## What happens on the deploy that lands this
 *
 *  1. The API process opens the SQLite database named by `MAPLE_SQLITE_PATH`.
 *  2. If that database records a completed cutover, it is skipped to step 5.
 *  3. Otherwise the process connects to MongoDB and runs the importer to
 *     completion, logging progress. It is not serving during this.
 *  4. It records the cutover in SQLite, so the next restart skips it.
 *  5. Only then does the caller spawn the worker child and start listening.
 *
 * For the production library — roughly 335,000 assets — step 3 is single-digit
 * minutes. That is the downtime, it happens once, and it is in the log rather
 * than inferred.
 *
 * ## Why this refuses to serve on failure
 *
 * Every other phase of this server's boot logs its failure and continues,
 * because a degraded subsystem is better than no server. This one is the
 * exception. A half-imported or empty library is indistinguishable, over the
 * API, from a library whose files have been deleted: the File Provider clients
 * would see every item vanish and act on it, and the change feed would publish
 * the deletions. So a migration that does not finish and verify stops the boot,
 * and the operator sees why.
 *
 * The same reasoning covers MongoDB being unreachable on a boot that still has
 * to migrate: "the source is not answering" and "the source is empty" have to
 * be told apart, and only the first is recoverable by waiting. Once the cutover
 * is recorded, MongoDB is never contacted again — which is what lets #3785
 * delete it.
 *
 * ## Resuming
 *
 * The importer checkpoints per collection and per batch, and its writes are
 * idempotent, so a boot killed halfway continues from where it stopped rather
 * than starting over or double-importing. That is why an unfinished database is
 * left in place rather than discarded: discarding it would throw away the work
 * and make an interrupted cutover restart from zero every time.
 *
 * ## Only one process migrates
 *
 * The worker tier is a separate child process with its own connection. It never
 * calls this, and the API does not spawn it until this has returned — so there
 * is exactly one writer for the duration of the import, and the worker cannot
 * claim a stage against a half-built library.
 */

import { Database } from 'bun:sqlite';
import { child as childLogger } from '../../log.ts';
import { DEFAULT_CHANGES_WINDOW } from './import/plan/index.ts';
import { closeImportSession, openImportSession, runImportOn } from './import/run.ts';
import type { ImportOptions } from './import/types.ts';
import { verifyImport } from './import/verify.ts';

const log = childLogger('sqlite:cutover');

/**
 * Where the database lives.
 *
 * An environment variable rather than a DB-backed setting, and one of the few
 * cases where that is the right answer rather than the lazy one: this is the
 * path to the database the settings themselves are stored in, so it has to be
 * known before anything is readable.
 *
 * The default sits beside the repository's other runtime state rather than in
 * a system directory, so a developer who sets nothing gets a working server and
 * an operator who sets it gets exactly the file they named.
 */
const DEFAULT_SQLITE_PATH = './data/maple.sqlite';

export function sqliteDatabasePath(): string {
  return process.env.MAPLE_SQLITE_PATH ?? DEFAULT_SQLITE_PATH;
}

/** The `server_state` row that records a finished cutover. */
const CUTOVER_STATE_ID = 'sqlite_cutover';

/** What one call to {@link migrateAtBoot} did. */
export type BootMigrationOutcome =
  | { status: 'already-migrated'; completedAt: string }
  | { status: 'migrated'; elapsedMs: number; assets: number };

/** Raised when the boot must not proceed to serving. */
export class BootMigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BootMigrationError';
  }
}

/**
 * Reads the cutover marker without migrating anything.
 *
 * Opens the file read-only and tolerates every "there is nothing there yet"
 * shape — a missing file, a database with no schema, a schema with no marker —
 * because all three mean the same thing to the caller: this database has not
 * been migrated. A database that cannot be opened for some *other* reason
 * (permissions, corruption) throws from `openImportSession` moments later, with
 * a better message than this function could give.
 */
function readCutoverMarker(path: string): string | null {
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const row = db.query(`SELECT value FROM server_state WHERE id = ?`).get(CUTOVER_STATE_ID) as {
      value: string | null;
    } | null;
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Writes the marker. Called only after the import has verified. */
function recordCutover(db: Database, completedAt: string): void {
  db.run(
    `INSERT INTO server_state (id, value) VALUES (?, ?)
       ON CONFLICT (id) DO UPDATE SET value = excluded.value`,
    [CUTOVER_STATE_ID, completedAt],
  );
}

/** How many assets landed, for the log line that says the cutover finished. */
function assetCount(db: Database): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM assets`).get() as { n: number };
  return row.n;
}

/**
 * The importer's settings for an unattended run.
 *
 * `restart: false` is the load-bearing one — it is what makes an interrupted
 * boot resume. The rest match the command-line tool's defaults, so a cutover
 * that runs here and one an operator ran by hand produce the same database.
 */
function bootImportOptions(path: string): ImportOptions {
  return {
    mongoUri: process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017',
    mongoDb: process.env.MAPLE_MONGO_DB ?? 'maple',
    sqlitePath: path,
    batchSize: 500,
    changesWindow: DEFAULT_CHANGES_WINDOW,
    verifySample: 200,
    restart: false,
    onProgress(progress) {
      log.info(
        {
          source: progress.source,
          done: progress.documentsDone,
          total: progress.documentsTotal,
          rejected: progress.rejected,
          elapsedMs: Math.round(progress.elapsedMs),
        },
        'importing',
      );
    },
  };
}

/**
 * Migrates from MongoDB if this database has not been migrated, and returns
 * once it is safe to serve. Throws {@link BootMigrationError} otherwise.
 *
 * The caller must not spawn the worker tier or start listening until this
 * resolves.
 */
/**
 * Which end of the import failed, said in the operator's terms (#3792).
 *
 * `openImportSession` opens the destination file first and only then connects
 * to the source, so a single message naming MongoDB reported a destination
 * problem as a source problem. That cost a production cutover: the server
 * restart-looped saying MongoDB was unreachable while MongoDB was healthy, and
 * the one fact that would have solved it — the path it had tried — appeared
 * only in the nested cause.
 *
 * The two failures have different fixes, so they get different sentences. The
 * refusal to serve is unchanged; only the explanation is.
 */
function openFailureMessage(
  cause: unknown,
  options: { mongoUri: string; sqlitePath: string },
): string {
  const name = cause instanceof Error ? cause.name : '';
  const text = cause instanceof Error ? cause.message : String(cause);
  const destination = name.startsWith('SQLite') || /unable to open database file/i.test(text);
  if (destination) {
    return (
      `cannot migrate to SQLite: the destination at ${options.sqlitePath} could not be opened. ` +
      'Its directory must exist and be writable by the server — inside a container that means a ' +
      'mounted volume, because this file is the library. Set MAPLE_SQLITE_PATH to an absolute ' +
      'path on that volume. The server will not serve an unmigrated library.'
    );
  }
  return (
    `cannot migrate to SQLite: the source database at ${options.mongoUri} is not reachable. ` +
    'The server will not serve an unmigrated library. Start MongoDB and restart the server, ' +
    'or point MAPLE_SQLITE_PATH at a database that has already been migrated.'
  );
}

export async function migrateAtBoot(): Promise<BootMigrationOutcome> {
  const path = sqliteDatabasePath();
  const recorded = readCutoverMarker(path);
  if (recorded !== null) {
    log.info({ path, completedAt: recorded }, 'SQLite cutover already done — skipping migration');
    return { status: 'already-migrated', completedAt: recorded };
  }

  const options = bootImportOptions(path);
  log.warn(
    { path, mongoUri: options.mongoUri, mongoDb: options.mongoDb },
    'SQLite database not migrated — importing from MongoDB before serving',
  );

  const startedAt = performance.now();
  const session = await openImportSession(options).catch((cause: unknown) => {
    throw new BootMigrationError(openFailureMessage(cause, options), { cause });
  });

  try {
    const report = await runImportOn(session, options);
    if (!report.derivedRestored) {
      throw new BootMigrationError(
        'the import did not reach the end: the derived triggers and the search index were ' +
          'never restored, so this database is not one to serve from. Restart to resume it.',
      );
    }

    const verified = await verifyImport(session.mongo, session.sqlite, options);
    if (!verified.ok) {
      const counts = verified.counts.filter((check) => !check.ok);
      const mismatches = counts.map((c) => `${c.table} ${c.expected}→${c.actual}`).join(', ');
      throw new BootMigrationError(
        'the import finished but did not verify, so the server will not serve it. ' +
          `Row-count mismatches: ${mismatches || 'none'}; ` +
          `field mismatches: ${verified.fields.filter((f) => !f.ok).length}; ` +
          `foreign-key violations: ${JSON.stringify(verified.foreignKeyViolations)}.`,
      );
    }

    const completedAt = new Date().toISOString();
    recordCutover(session.sqlite, completedAt);
    const assets = assetCount(session.sqlite);
    const elapsedMs = Math.round(performance.now() - startedAt);
    // The released locations are in the log rather than only in the report an
    // unattended boot never prints: a library that carried two entries for one
    // file path comes out of this with one, and an operator should hear the
    // number from the run that decided it.
    log.info(
      {
        path,
        assets,
        elapsedMs,
        contestedAddresses: report.contestedAddresses,
        locationsReleased: report.locationsReleased,
      },
      'SQLite cutover complete — serving on SQLite',
    );
    return { status: 'migrated', elapsedMs, assets };
  } catch (err) {
    if (err instanceof BootMigrationError) throw err;
    throw new BootMigrationError(
      'the migration from MongoDB to SQLite failed. The server will not serve a partially ' +
        'imported library — the clients cannot tell one from a deleted one. The database keeps ' +
        'its progress, so restarting resumes rather than starting over.',
      { cause: err },
    );
  } finally {
    await closeImportSession(session);
  }
}
