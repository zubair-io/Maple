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
 * `bun:sqlite` is used directly and on purpose. This script owns its process and
 * has no event loop to protect, so the worker-backed pool the API runs through
 * would only add a message hop per statement.
 */

import { Database } from 'bun:sqlite';
import {
  closeImportSession,
  openImportSession,
  runImportOn,
  verifyImport,
  DEFAULT_CHANGES_WINDOW,
  SKIPPED_COLLECTIONS,
  type ImportOptions,
  type ImportReport,
  type VerifyReport,
} from '../src/db/sqlite/import/index.ts';

const USAGE = `
Usage: bun scripts/mongo-to-sqlite.ts --out <file.db> [options]

  --out <path>            Destination SQLite file. Required.
  --mongo-uri <uri>       Source connection string.
                          Default: $MAPLE_MONGO_URI or mongodb://localhost:27017
  --mongo-db <name>       Source database. Default: $MAPLE_MONGO_DB or "maple"
  --batch <n>             Documents per transaction. Default: 500
  --changes-window <n>    Newest asset_changes rows to carry, or "all".
                          Default: ${DEFAULT_CHANGES_WINDOW}
  --verify-sample <n>     Documents sampled per collection for the field checks.
                          Default: 200
  --no-verify             Import without running the verification pass.
  --restart               Delete the destination and import from scratch.
  --help                  Print this message.
`.trim();

interface Cli extends ImportOptions {
  verify: boolean;
}

function parseArgs(argv: readonly string[]): Cli | null {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  if (flags.has('help') || args.has('help')) return null;

  const out = args.get('out');
  if (out === undefined) {
    process.stderr.write('--out is required\n\n');
    return null;
  }

  const rawWindow = args.get('changes-window');
  const changesWindow =
    rawWindow === undefined
      ? DEFAULT_CHANGES_WINDOW
      : rawWindow === 'all'
        ? ('all' as const)
        : Number.parseInt(rawWindow, 10);
  if (typeof changesWindow === 'number' && !Number.isFinite(changesWindow)) {
    process.stderr.write('--changes-window must be a number or "all"\n\n');
    return null;
  }

  return {
    mongoUri: args.get('mongo-uri') ?? process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017',
    mongoDb: args.get('mongo-db') ?? process.env.MAPLE_MONGO_DB ?? 'maple',
    sqlitePath: out,
    batchSize: Number.parseInt(args.get('batch') ?? '500', 10),
    changesWindow,
    verifySample: Number.parseInt(args.get('verify-sample') ?? '200', 10),
    restart: flags.has('restart'),
    verify: !flags.has('no-verify'),
  };
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

function reportImport(report: ImportReport): void {
  write('');
  write('Imported');
  write('  collection                 documents   rejected      time');
  for (const entry of report.collections) {
    const suffix = entry.skipped ? '  (already complete)' : '';
    write(
      `  ${entry.source.padEnd(26)}${String(entry.documents).padStart(9)}` +
        `${String(entry.rejected).padStart(11)}${formatDuration(entry.elapsedMs).padStart(10)}` +
        suffix,
    );
  }
  write(
    `  ${'total'.padEnd(26)}${''.padStart(20)}${formatDuration(report.totalElapsedMs).padStart(10)}`,
  );

  if (report.changesCursorFloor !== null) {
    write('');
    write(
      `Change log imported from cursor ${report.changesCursorFloor} upward. Older cursors ` +
        're-enumerate, which clients already handle.',
    );
  }

  const noteSections: Array<[string, Record<string, number>]> = [
    ['Dangling references nulled', report.danglingNulled],
    ['Rows dropped for a missing required reference', report.danglingDropped],
    ['Values substituted to satisfy a constraint', report.substitutions],
  ];
  for (const [title, entries] of noteSections) {
    const keys = Object.keys(entries);
    if (keys.length === 0) continue;
    write('');
    write(title);
    for (const key of keys.sort()) write(`  ${key}: ${entries[key]}`);
  }

  if (report.unknownStages.length > 0) {
    write('');
    write(`Retired stage names carried over: ${report.unknownStages.join(', ')}`);
  }

  if (report.rejects.length > 0) {
    write('');
    write(`${report.rejects.length} document(s) could not be imported:`);
    for (const reject of report.rejects.slice(0, 20)) {
      write(`  ${reject.source} ${reject.sourceId}: ${reject.reason}`);
    }
    if (report.rejects.length > 20) write(`  … and ${report.rejects.length - 20} more`);
  }

  write('');
  write('Not imported, deliberately:');
  for (const [collection, reason] of Object.entries(SKIPPED_COLLECTIONS)) {
    write(`  ${collection.padEnd(26)}${reason}`);
  }
}

function reportVerify(report: VerifyReport): void {
  write('');
  write('Verification');
  write('  table                          expected      actual');
  for (const entry of report.counts) {
    const mark = entry.ok ? ' ' : '!';
    write(
      `${mark} ${entry.table.padEnd(30)}${String(entry.expected).padStart(9)}` +
        `${String(entry.actual).padStart(12)}`,
    );
  }

  const badFields = report.fields.filter((entry) => !entry.ok);
  write('');
  write(
    `  field checks: ${report.fields.length - badFields.length}/${report.fields.length} passed`,
  );
  for (const entry of badFields.slice(0, 20)) {
    write(`  ! ${entry.source} ${entry.sourceId} ${entry.field}`);
    write(`      expected ${entry.expected}`);
    write(`      actual   ${entry.actual}`);
  }
  if (badFields.length > 20) write(`  … and ${badFields.length - 20} more`);

  const violations = Object.entries(report.foreignKeyViolations);
  write(
    violations.length === 0
      ? '  foreign keys: clean'
      : `  ! foreign keys: ${violations.map(([t, n]) => `${t}=${n}`).join(', ')}`,
  );

  write('');
  write(report.ok ? 'VERIFIED — the import is complete and correct.' : 'FAILED verification.');
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    write(USAGE);
    return 1;
  }

  write(`Source: ${options.mongoUri} / ${options.mongoDb}`);
  write(`Destination: ${options.sqlitePath}`);
  write('');

  // The live counter rewrites one line, which is only readable on a terminal.
  // Redirected to a file it would be tens of thousands of carriage returns on
  // one unreadable line, so a non-interactive run reports once per collection
  // instead — which is what an operator piping this to a log actually wants.
  const interactive = process.stderr.isTTY === true;
  const session = await openImportSession(options);
  let report: ImportReport;
  let verified: VerifyReport | null = null;
  try {
    let lastSource = '';
    report = await runImportOn(session, {
      ...options,
      onProgress(progress) {
        const line = `${progress.source}: ${progress.documentsDone}/${progress.documentsTotal}`;
        if (interactive) {
          process.stderr.write(`\r${line.padEnd(60)}`);
          return;
        }
        if (progress.source === lastSource) return;
        lastSource = progress.source;
        process.stderr.write(`${progress.source}: ${progress.documentsTotal} documents\n`);
      },
    });
    if (interactive) process.stderr.write('\r'.padEnd(62));
    if (options.verify) verified = await verifyImport(session.mongo, session.sqlite, options);
  } finally {
    await closeImportSession(session);
  }

  reportImport(report);
  if (verified !== null) reportVerify(verified);

  // Reopen briefly to hand the operator the size of what they now own, and to
  // confirm the file opens cleanly with the pragmas the server will use.
  const check = new Database(options.sqlitePath, { readonly: true });
  const page = check.query(`PRAGMA page_count`).get() as { page_count: number };
  const size = check.query(`PRAGMA page_size`).get() as { page_size: number };
  check.close();
  write('');
  write(`Database: ${((page.page_count * size.page_size) / 1_000_000).toFixed(1)} MB`);

  return verified === null || verified.ok ? 0 : 1;
}

process.exitCode = await main();
