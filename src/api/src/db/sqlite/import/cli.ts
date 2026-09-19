/**
 * The importer's command line and its report rendering, as pure functions.
 *
 * Kept apart from `scripts/mongo-to-sqlite.ts` so both halves can be tested
 * without running an import: parsing turns an `argv` array into options and
 * nothing else, and rendering turns a finished report into lines of text and
 * nothing else. The script is then the part that cannot be tested without a
 * database — opening the session, driving the import, printing what comes back.
 *
 * That matters more here than it would for most CLIs, because the flags decide
 * what an operator's one-shot migration actually does. `--changes-window`
 * chooses how much of the change log survives, and `--restart` deletes the
 * destination; both are worth a test rather than a careful read.
 */

import type { ImportReport, VerifyReport } from './types.ts';
import {
  DEFAULT_CHANGES_WINDOW,
  MANAGED_CERTIFICATES_WARNING,
  SKIPPED_COLLECTIONS,
} from './plan/index.ts';

/** How many entries of a failure list to print before summarising the rest. */
const LIST_LIMIT = 20;

export const USAGE = `
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

/** The options an import run takes, plus whether to verify afterwards. */
export interface CliOptions {
  mongoUri: string;
  mongoDb: string;
  sqlitePath: string;
  batchSize: number;
  changesWindow: number | 'all';
  verifySample: number;
  restart: boolean;
  verify: boolean;
}

/** `--name value` pairs and bare `--flag`s, separated. */
export interface Argv {
  values: Map<string, string>;
  flags: Set<string>;
}

/** Splits an argument list into valued options and bare flags. */
export function splitArgv(argv: readonly string[]): Argv {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.add(arg.slice(2));
      continue;
    }
    values.set(arg.slice(2), next);
    index += 1;
  }
  return { values, flags };
}

/** An integer option, or its default when the flag was not given. */
function intOption(argv: Argv, name: string, fallback: number): number {
  const raw = argv.values.get(name);
  return raw === undefined ? fallback : Number.parseInt(raw, 10);
}

/** A string option, falling back to an environment variable then a default. */
function textOption(argv: Argv, name: string, env: string | undefined, fallback: string): string {
  return argv.values.get(name) ?? env ?? fallback;
}

/** `--changes-window`: a row count, `'all'`, or null when it is neither. */
export function parseChangesWindow(raw: string | undefined): number | 'all' | null {
  if (raw === undefined) return DEFAULT_CHANGES_WINDOW;
  if (raw === 'all') return 'all';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** What went wrong with a command line, for the caller to print. */
export interface CliError {
  error: string;
}

/** True when parsing produced a complaint rather than options. */
export function isCliError(result: CliOptions | CliError): result is CliError {
  return 'error' in result;
}

/**
 * The parsed command line, or the complaint to print alongside the usage text.
 * `--help` is a complaint with an empty message: usage, and nothing else.
 */
export function parseArgs(
  raw: readonly string[],
  env: NodeJS.ProcessEnv = {},
): CliOptions | CliError {
  const argv = splitArgv(raw);
  if (argv.flags.has('help') || argv.values.has('help')) return { error: '' };

  const out = argv.values.get('out');
  if (out === undefined) return { error: '--out is required' };

  const changesWindow = parseChangesWindow(argv.values.get('changes-window'));
  if (changesWindow === null) return { error: '--changes-window must be a number or "all"' };

  return {
    mongoUri: textOption(argv, 'mongo-uri', env.MAPLE_MONGO_URI, 'mongodb://localhost:27017'),
    mongoDb: textOption(argv, 'mongo-db', env.MAPLE_MONGO_DB, 'maple'),
    sqlitePath: out,
    batchSize: intOption(argv, 'batch', 500),
    changesWindow,
    verifySample: intOption(argv, 'verify-sample', 200),
    restart: argv.flags.has('restart'),
    verify: !argv.flags.has('no-verify'),
  };
}

/** A duration an operator reads as downtime rather than as a millisecond count. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/** The per-collection table of documents, rejects and time. */
function renderCollections(report: ImportReport): string[] {
  const rows = report.collections.map((entry) => {
    const suffix = entry.skipped ? '  (already complete)' : '';
    return (
      `  ${entry.source.padEnd(26)}${String(entry.documents).padStart(9)}` +
      `${String(entry.rejected).padStart(11)}${formatDuration(entry.elapsedMs).padStart(10)}` +
      suffix
    );
  });
  return [
    '',
    'Imported',
    '  collection                 documents   rejected      time',
    ...rows,
    `  ${'total'.padEnd(26)}${''.padStart(20)}${formatDuration(report.totalElapsedMs).padStart(10)}`,
  ];
}

/** Anything the run substituted, repaired or carried over under protest. */
function renderNotes(report: ImportReport): string[] {
  const out: string[] = [];
  if (report.changesCursorFloor !== null) {
    out.push(
      '',
      `Change log imported from cursor ${report.changesCursorFloor} upward. Older cursors ` +
        're-enumerate, which clients already handle.',
    );
  }

  for (const override of report.windowOverrides) {
    out.push(
      '',
      `--changes-window ${override.requested} was ignored: this run resumed one that already ` +
        `fixed ${override.source} at ${override.inEffect}, and a resumed run has to read the ` +
        'same set. Use --restart to import a different window.',
    );
  }

  if (!report.derivedRestored) {
    out.push(
      '',
      'INCOMPLETE — the derived triggers and the search index are still switched off, so this ' +
        'file is not one to point a server at. Run the same command again to finish it.',
    );
  }

  if (report.contestedAddresses > 0) {
    out.push(
      '',
      `${report.contestedAddresses} file path(s) were claimed by more than one location entry. ` +
        'One entry keeps each path and the others were released — their assets are imported ' +
        'whole, without that one location. Decided by:',
      ...Object.keys(report.locationsReleased)
        .sort()
        .map((rule) => `  ${rule}: ${report.locationsReleased[rule]}`),
    );
  }

  const sections: Array<[string, Record<string, number>]> = [
    ['Dangling references nulled', report.danglingNulled],
    ['Rows dropped for a missing required reference', report.danglingDropped],
    ['Values substituted to satisfy a constraint', report.substitutions],
  ];
  for (const [title, entries] of sections) {
    const keys = Object.keys(entries).sort();
    if (keys.length > 0) {
      out.push('', title, ...keys.map((key) => `  ${key}: ${entries[key]}`));
    }
  }

  if (report.unknownStages.length > 0) {
    out.push('', `Retired stage names carried over: ${report.unknownStages.join(', ')}`);
  }
  return out;
}

/** Documents that could not be written at all. */
function renderRejects(report: ImportReport): string[] {
  if (report.rejects.length === 0) return [];
  const shown = report.rejects
    .slice(0, LIST_LIMIT)
    .map((reject) => `  ${reject.source} ${reject.sourceId}: ${reject.reason}`);
  const overflow = report.rejects.length - LIST_LIMIT;
  return [
    '',
    `${report.rejects.length} document(s) could not be imported:`,
    ...shown,
    ...(overflow > 0 ? [`  … and ${overflow} more`] : []),
  ];
}

/** The whole import summary, as lines. */
export function renderImportReport(report: ImportReport): string[] {
  return [
    ...renderCollections(report),
    ...renderNotes(report),
    ...renderRejects(report),
    '',
    'Not imported, deliberately:',
    ...Object.entries(SKIPPED_COLLECTIONS).map(
      ([collection, reason]) => `  ${collection.padEnd(30)}${reason}`,
    ),
    '',
    `  ${MANAGED_CERTIFICATES_WARNING}`,
  ];
}

/** The per-table count table. */
function renderCounts(report: VerifyReport): string[] {
  const rows = report.counts.map(
    (entry) =>
      `${entry.ok ? ' ' : '!'} ${entry.table.padEnd(30)}${String(entry.expected).padStart(9)}` +
      `${String(entry.actual).padStart(12)}`,
  );
  return ['', 'Verification', '  table                          expected      actual', ...rows];
}

/** How many field checks passed, and the first few that did not. */
function renderFields(report: VerifyReport): string[] {
  const bad = report.fields.filter((entry) => !entry.ok);
  const shown = bad
    .slice(0, LIST_LIMIT)
    .flatMap((entry) => [
      `  ! ${entry.source} ${entry.sourceId} ${entry.field}`,
      `      expected ${entry.expected}`,
      `      actual   ${entry.actual}`,
    ]);
  const overflow = bad.length - LIST_LIMIT;
  return [
    '',
    `  field checks: ${report.fields.length - bad.length}/${report.fields.length} passed`,
    ...shown,
    ...(overflow > 0 ? [`  … and ${overflow} more`] : []),
  ];
}

/** The whole verification summary, as lines, ending in the verdict. */
export function renderVerifyReport(report: VerifyReport): string[] {
  const violations = Object.entries(report.foreignKeyViolations);
  return [
    ...renderCounts(report),
    ...renderFields(report),
    violations.length === 0
      ? '  foreign keys: clean'
      : `  ! foreign keys: ${violations.map(([table, n]) => `${table}=${n}`).join(', ')}`,
    ...(report.derivedRestored
      ? []
      : ['  ! derived triggers and search index are still switched off']),
    '',
    report.ok ? 'VERIFIED — the import is complete and correct.' : 'FAILED verification.',
  ];
}

/** Everything a finished run has to say, as lines. */
export function renderRun(report: ImportReport, verified: VerifyReport | null): string[] {
  const verification = verified === null ? [] : renderVerifyReport(verified);
  return [...renderImportReport(report), ...verification];
}
