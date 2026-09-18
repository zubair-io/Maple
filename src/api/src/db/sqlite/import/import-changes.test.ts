/**
 * The change-log window (#3744).
 *
 * `asset_changes` is the one collection the importer deliberately does not
 * carry whole: around 176 million rows on production whose only job is
 * answering "what changed since cursor N", against a library that is the
 * authority any client can fall back to by re-enumerating. The reasoning is in
 * `plan/library.ts`; these tests hold the behaviour to it.
 *
 * Two properties matter. The window keeps the NEWEST rows, because those are
 * the ones a recently-synced client will ask about. And the floor is fixed on
 * the first run, so a resumed import reads the same set even though the source
 * has moved on in between — otherwise a second run would import a different
 * window over an already-imported prefix.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId, type MongoClient } from 'mongodb';
import {
  closeImportSession,
  openImportSession,
  runImportOn,
  verifyImport,
  type ImportOptions,
} from './index.ts';
import {
  connectTestMongo,
  seedLibrary,
  TEST_MONGO_URI,
  type SeedIds,
} from './seed.test-helpers.ts';

const DB_NAME = `maple_import_changes_${process.pid}`;

let client: MongoClient | null = null;
let ids: SeedIds | null = null;
let workDir = '';

function options(sqlitePath: string, changesWindow: number | 'all'): ImportOptions {
  return {
    mongoUri: TEST_MONGO_URI,
    mongoDb: DB_NAME,
    sqlitePath,
    batchSize: 5,
    changesWindow,
    verifySample: 10,
    restart: false,
  };
}

function cursors(sqlitePath: string): number[] {
  const db = new Database(sqlitePath, { readonly: true });
  const rows = db.query(`SELECT cursor FROM asset_changes ORDER BY cursor`).all() as Array<{
    cursor: number;
  }>;
  db.close();
  return rows.map((row) => row.cursor);
}

beforeAll(async () => {
  client = await connectTestMongo();
  if (client === null) return;
  await client.db(DB_NAME).dropDatabase();
  ids = await seedLibrary(client.db(DB_NAME), { changeRows: 20 });
  workDir = mkdtempSync(join(tmpdir(), 'maple-import-changes-'));
}, 60_000);

afterAll(async () => {
  if (client !== null) {
    await client.db(DB_NAME).dropDatabase();
    await client.close();
  }
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

describe('the change-log window', () => {
  it('carries the newest rows and reports the floor it settled on', async () => {
    if (client === null || ids === null) return;
    const path = join(workDir, 'window.db');
    const run = { ...options(path, 5), restart: true };
    const session = await openImportSession(run);
    let report;
    let verified;
    try {
      report = await runImportOn(session, run);
      verified = await verifyImport(session.mongo, session.sqlite, run);
    } finally {
      await closeImportSession(session);
    }

    expect(cursors(path)).toEqual([16, 17, 18, 19, 20]);
    expect(report?.changesCursorFloor).toBe(16);
    // The count check compares against the windowed source set, not the whole
    // collection, so a deliberate window is not reported as a shortfall.
    expect(verified?.counts.find((entry) => entry.table === 'asset_changes')).toEqual({
      table: 'asset_changes',
      expected: 5,
      actual: 5,
      ok: true,
    });
  }, 60_000);

  it('holds the floor across a resume, even when the source moved on', async () => {
    const seeded = ids;
    if (client === null || seeded === null) return;
    const path = join(workDir, 'resume-window.db');
    const run = { ...options(path, 5), restart: true };
    const first = await openImportSession(run);
    try {
      await runImportOn(first, run);
    } finally {
      await closeImportSession(first);
    }
    expect(cursors(path)).toEqual([16, 17, 18, 19, 20]);

    // The server kept running for a moment after the first pass.
    await client
      .db(DB_NAME)
      .collection('asset_changes')
      .insertMany(
        [21, 22, 23, 24, 25, 26].map((cursor) => ({
          cursor,
          asset_id: new ObjectId(seeded.assets.rich),
          folder_id: new ObjectId(seeded.libraryA),
          kind: 'update',
          abs_path: `/libraries/a/late-${cursor}.dng`,
          relative_path: `late-${cursor}.dng`,
          at: new Date(),
        })) as never,
      );

    const second = await openImportSession(options(path, 5));
    try {
      await runImportOn(second, options(path, 5));
    } finally {
      await closeImportSession(second);
    }

    // Still the window the first run fixed — not a fresh one over cursor 22+.
    expect(cursors(path)).toEqual([16, 17, 18, 19, 20]);
  }, 60_000);

  it('imports every row when the operator asks for the whole log', async () => {
    if (client === null) return;
    const path = join(workDir, 'all.db');
    const run = { ...options(path, 'all'), restart: true };
    const session = await openImportSession(run);
    let report;
    try {
      report = await runImportOn(session, run);
    } finally {
      await closeImportSession(session);
    }
    // 20 seeded, plus the 6 the previous test appended.
    expect(cursors(path)).toHaveLength(26);
    expect(report?.changesCursorFloor).toBeNull();
  }, 60_000);
});
