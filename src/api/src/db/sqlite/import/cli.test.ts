/**
 * The importer's command line and its report rendering (#3744).
 *
 * Worth testing rather than reading carefully, because these flags decide what
 * a one-shot migration does to an operator's library: `--changes-window`
 * chooses how much of the change log survives, and `--restart` deletes the
 * destination. Everything here is pure, so none of it needs a database.
 */

import { describe, expect, it } from 'bun:test';
import {
  formatDuration,
  isCliError,
  parseArgs,
  parseChangesWindow,
  renderImportReport,
  renderRun,
  renderVerifyReport,
  splitArgv,
  type CliOptions,
} from './cli.ts';
import { DEFAULT_CHANGES_WINDOW } from './plan/index.ts';
import type { ImportReport, VerifyReport } from './types.ts';

/** Parses and asserts success, so a test reads as the options it asked for. */
function options(argv: string[], env: NodeJS.ProcessEnv = {}): CliOptions {
  const parsed = parseArgs(argv, env);
  if (isCliError(parsed)) throw new Error(`unexpected CLI error: ${parsed.error}`);
  return parsed;
}

describe('splitArgv', () => {
  it('separates valued options from bare flags', () => {
    const { values, flags } = splitArgv(['--out', 'a.db', '--restart', '--batch', '10']);
    expect([...values]).toEqual([
      ['out', 'a.db'],
      ['batch', '10'],
    ]);
    expect([...flags]).toEqual(['restart']);
  });

  it('treats an option followed by another option as a flag', () => {
    const { values, flags } = splitArgv(['--no-verify', '--out', 'a.db']);
    expect([...flags]).toEqual(['no-verify']);
    expect(values.get('out')).toBe('a.db');
  });

  it('ignores positional arguments', () => {
    const { values, flags } = splitArgv(['stray', '--out', 'a.db']);
    expect(values.get('out')).toBe('a.db');
    expect(flags.size).toBe(0);
  });
});

describe('parseChangesWindow', () => {
  it('defaults to the documented window', () => {
    expect(parseChangesWindow(undefined)).toBe(DEFAULT_CHANGES_WINDOW);
  });

  it('accepts a row count and the literal "all"', () => {
    expect(parseChangesWindow('250')).toBe(250);
    expect(parseChangesWindow('all')).toBe('all');
  });

  it('rejects anything else rather than silently defaulting', () => {
    expect(parseChangesWindow('some')).toBeNull();
  });
});

describe('parseArgs', () => {
  it('requires a destination', () => {
    const parsed = parseArgs([]);
    expect(isCliError(parsed) && parsed.error).toBe('--out is required');
  });

  it('answers --help with usage and no complaint', () => {
    const parsed = parseArgs(['--help']);
    expect(isCliError(parsed) && parsed.error).toBe('');
  });

  it('rejects a --changes-window that is neither a number nor "all"', () => {
    const parsed = parseArgs(['--out', 'a.db', '--changes-window', 'lots']);
    expect(isCliError(parsed) && parsed.error).toContain('--changes-window');
  });

  it('fills in the documented defaults', () => {
    expect(options(['--out', 'a.db'])).toEqual({
      mongoUri: 'mongodb://localhost:27017',
      mongoDb: 'maple',
      sqlitePath: 'a.db',
      batchSize: 500,
      changesWindow: DEFAULT_CHANGES_WINDOW,
      verifySample: 200,
      restart: false,
      verify: true,
    });
  });

  it('prefers the environment over the defaults, and a flag over both', () => {
    const env = { MAPLE_MONGO_URI: 'mongodb://box:27017', MAPLE_MONGO_DB: 'library' };
    expect(options(['--out', 'a.db'], env)).toMatchObject({
      mongoUri: 'mongodb://box:27017',
      mongoDb: 'library',
    });
    expect(options(['--out', 'a.db', '--mongo-db', 'other'], env)).toMatchObject({
      mongoDb: 'other',
    });
  });

  it('reads the two destructive-ish switches', () => {
    expect(options(['--out', 'a.db', '--restart', '--no-verify'])).toMatchObject({
      restart: true,
      verify: false,
    });
  });
});

describe('formatDuration', () => {
  it('scales from milliseconds to minutes', () => {
    expect(formatDuration(42)).toBe('42 ms');
    expect(formatDuration(1500)).toBe('1.5 s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
});

const EMPTY_REPORT: ImportReport = {
  collections: [
    { source: 'folders', documents: 2, rejected: 0, elapsedMs: 3, skipped: false },
    { source: 'assets', documents: 6, rejected: 0, elapsedMs: 1200, skipped: true },
  ],
  rejects: [],
  danglingNulled: {},
  danglingDropped: {},
  substitutions: {},
  unknownStages: [],
  changesCursorFloor: null,
  totalElapsedMs: 1203,
};

describe('renderImportReport', () => {
  it('lists every collection and marks the ones already complete', () => {
    const lines = renderImportReport(EMPTY_REPORT).join('\n');
    expect(lines).toContain('folders');
    expect(lines).toContain('assets');
    expect(lines).toContain('(already complete)');
    expect(lines).toContain('Not imported, deliberately:');
    expect(lines).toContain('image_access_tokens');
  });

  it('says nothing about repairs when there were none', () => {
    const lines = renderImportReport(EMPTY_REPORT).join('\n');
    expect(lines).not.toContain('Dangling references nulled');
    expect(lines).not.toContain('could not be imported');
  });

  it('names the change-log floor, the repairs and the rejects when there are any', () => {
    const lines = renderImportReport({
      ...EMPTY_REPORT,
      changesCursorFloor: 150_001,
      danglingNulled: { 'faces.person_id': 3 },
      danglingDropped: { 'asset_locations.library_id': 1 },
      substitutions: { 'assets.rating clamped': 2 },
      unknownStages: ['face', 'hash'],
      rejects: [{ source: 'people', sourceId: 'abc', reason: 'duplicate name' }],
    }).join('\n');
    expect(lines).toContain('cursor 150001 upward');
    expect(lines).toContain('faces.person_id: 3');
    expect(lines).toContain('asset_locations.library_id: 1');
    expect(lines).toContain('assets.rating clamped: 2');
    expect(lines).toContain('Retired stage names carried over: face, hash');
    expect(lines).toContain('people abc: duplicate name');
  });
});

const PASSING_VERIFY: VerifyReport = {
  counts: [{ table: 'assets', expected: 6, actual: 6, ok: true }],
  fields: [
    { source: 'assets', sourceId: 'a', field: 'assets.id', expected: 'a', actual: 'a', ok: true },
  ],
  foreignKeyViolations: {},
  rejects: [],
  ok: true,
};

describe('renderVerifyReport', () => {
  it('ends in the verdict when everything passed', () => {
    const lines = renderVerifyReport(PASSING_VERIFY);
    expect(lines.at(-1)).toBe('VERIFIED — the import is complete and correct.');
    expect(lines.join('\n')).toContain('field checks: 1/1 passed');
    expect(lines.join('\n')).toContain('foreign keys: clean');
  });

  it('marks the failing rows and ends in the failure', () => {
    const lines = renderVerifyReport({
      counts: [{ table: 'assets', expected: 6, actual: 5, ok: false }],
      fields: [
        {
          source: 'assets',
          sourceId: 'a',
          field: 'assets.size',
          expected: '10',
          actual: '0',
          ok: false,
        },
      ],
      foreignKeyViolations: { faces: 2 },
      rejects: [],
      ok: false,
    }).join('\n');
    expect(lines).toContain('! assets');
    expect(lines).toContain('field checks: 0/1 passed');
    expect(lines).toContain('expected 10');
    expect(lines).toContain('! foreign keys: faces=2');
    expect(lines).toContain('FAILED verification.');
  });
});

describe('renderRun', () => {
  it('omits the verification section when it was skipped', () => {
    expect(renderRun(EMPTY_REPORT, null).join('\n')).not.toContain('Verification');
    expect(renderRun(EMPTY_REPORT, PASSING_VERIFY).join('\n')).toContain('Verification');
  });
});
