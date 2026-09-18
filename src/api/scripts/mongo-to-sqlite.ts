/**
 * One-shot MongoDB → SQLite import for an existing Self Hosted install (#3744).
 *
 *   bun scripts/mongo-to-sqlite.ts --out /var/lib/maple/maple.db
 *   bun scripts/mongo-to-sqlite.ts --out maple.db --mongo-db maple --changes-window all
 *   bun scripts/mongo-to-sqlite.ts --out maple.db --restart
 *
 * Stop the server first. The importer reads MongoDB and writes a SQLite file;
 * it never writes to MongoDB, so a copy of the library is a safe rehearsal and
 * the original stays available as the rollback.
 *
 * An interrupted run resumes: re-running the same command continues from the
 * last committed batch rather than starting over, because the checkpoint commits
 * in the same transaction as the rows it describes. `--restart` deletes the
 * destination and begins again.
 *
 * This file is only the part that needs a database. Argument parsing and report
 * rendering are pure functions in `src/db/sqlite/import/cli.ts`, where they are
 * tested.
 *
 * `bun:sqlite` is used directly and on purpose. This script owns its process and
 * has no event loop to protect, so the worker-backed pool the API runs through
 * would only add a message hop per statement.
 */

import { Database } from 'bun:sqlite';
import {
  isCliError,
  parseArgs,
  renderRun,
  USAGE,
  type CliOptions,
} from '../src/db/sqlite/import/cli.ts';
import { closeImportSession, openImportSession, runImportOn } from '../src/db/sqlite/import/run.ts';
import type { ImportProgress, ImportReport, VerifyReport } from '../src/db/sqlite/import/types.ts';
import { verifyImport } from '../src/db/sqlite/import/verify.ts';

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * A progress reporter for the terminal, or for a log file.
 *
 * The live counter rewrites one line, which only reads as progress on a
 * terminal. Redirected to a file it would be tens of thousands of carriage
 * returns on one unreadable line, so a non-interactive run reports once per
 * collection instead — which is what an operator piping this to a log wants.
 */
function makeProgressReporter(interactive: boolean): (progress: ImportProgress) => void {
  let lastSource = '';
  return (progress) => {
    if (interactive) {
      const line = `${progress.source}: ${progress.documentsDone}/${progress.documentsTotal}`;
      process.stderr.write(`\r${line.padEnd(60)}`);
      return;
    }
    if (progress.source === lastSource) return;
    lastSource = progress.source;
    process.stderr.write(`${progress.source}: ${progress.documentsTotal} documents\n`);
  };
}

/** Imports, then verifies unless the operator asked not to. */
async function importAndVerify(
  options: CliOptions,
): Promise<{ report: ImportReport; verified: VerifyReport | null }> {
  const interactive = process.stderr.isTTY === true;
  const session = await openImportSession(options);
  try {
    const onProgress = makeProgressReporter(interactive);
    const report = await runImportOn(session, { ...options, onProgress });
    if (interactive) process.stderr.write('\r'.padEnd(62));
    const verified = options.verify
      ? await verifyImport(session.mongo, session.sqlite, options)
      : null;
    return { report, verified };
  } finally {
    await closeImportSession(session);
  }
}

/** The size of what the operator now owns, and that the file opens cleanly. */
function databaseSize(path: string): string {
  const db = new Database(path, { readonly: true });
  const pages = (db.query(`PRAGMA page_count`).get() as { page_count: number }).page_count;
  const pageSize = (db.query(`PRAGMA page_size`).get() as { page_size: number }).page_size;
  db.close();
  return `${((pages * pageSize) / 1_000_000).toFixed(1)} MB`;
}

/** Prints the complaint, if there is one, and the usage text. Always exit 1. */
function reportUsage(error: string): number {
  if (error !== '') process.stderr.write(`${error}\n\n`);
  write(USAGE);
  return 1;
}

/** A skipped verification is not a failed one. */
function verificationFailed(verified: VerifyReport | null): boolean {
  return verified !== null && !verified.ok;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2), process.env);
  if (isCliError(options)) return reportUsage(options.error);

  write(`Source: ${options.mongoUri} / ${options.mongoDb}`);
  write(`Destination: ${options.sqlitePath}`);
  write('');

  const { report, verified } = await importAndVerify(options);
  for (const line of renderRun(report, verified)) write(line);
  write('');
  write(`Database: ${databaseSize(options.sqlitePath)}`);
  return verificationFailed(verified) ? 1 : 0;
}

process.exitCode = await main();
