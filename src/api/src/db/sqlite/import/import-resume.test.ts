/**
 * Resumption: interrupting the import halfway and re-running converges on the
 * same database (#3744).
 *
 * The interruption is real rather than simulated. The first run is driven with
 * a batch size of one and a progress callback that throws once a threshold is
 * crossed, so it dies part-way through the assets — after some batches have
 * committed and before the rest have been read. The second run is the same
 * command again, with `restart: false`, which is exactly what an operator
 * types.
 *
 * Convergence is then asserted against a THIRD database imported in one clean
 * pass. Comparing the resumed result to a checkpoint of itself would only prove
 * it is self-consistent; comparing it to an uninterrupted import of the same
 * source proves it is right.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MongoClient } from 'mongodb';
import { readCheckpoint } from './bookkeeping.ts';
import { closeImportSession, openImportSession, runImportOn } from './run.ts';
import type { ImportOptions } from './types.ts';
import { verifyImport } from './verify.ts';
import { connectTestMongo, seedLibrary, TEST_MONGO_URI } from './seed.test-helpers.ts';

const DB_NAME = `maple_import_resume_${process.pid}`;

let client: MongoClient | null = null;
let workDir = '';

function baseOptions(sqlitePath: string): ImportOptions {
  return {
    mongoUri: TEST_MONGO_URI,
    mongoDb: DB_NAME,
    sqlitePath,
    batchSize: 1,
    changesWindow: 'all',
    verifySample: 25,
    restart: false,
  };
}

/** Every table's row count, as a comparable snapshot. */
function snapshot(sqlitePath: string): Record<string, number> {
  const db = new Database(sqlitePath, { readonly: true });
  const tables = db
    .query(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE 'assets_fts%' AND name NOT LIKE 'import_%'
        ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  const out: Record<string, number> = {};
  for (const { name } of tables) {
    const row = db.query(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number };
    out[name] = row.n;
  }
  db.close();
  return out;
}

/** Every asset row, fully, so convergence is content and not just counts. */
function assetRows(sqlitePath: string): unknown[] {
  const db = new Database(sqlitePath, { readonly: true });
  const rows = db.query(`SELECT * FROM assets ORDER BY id`).all();
  db.close();
  return rows;
}

beforeAll(async () => {
  client = await connectTestMongo();
  if (client === null) return;
  await client.db(DB_NAME).dropDatabase();
  await seedLibrary(client.db(DB_NAME));
  workDir = mkdtempSync(join(tmpdir(), 'maple-import-resume-'));
}, 60_000);

afterAll(async () => {
  if (client !== null) {
    await client.db(DB_NAME).dropDatabase();
    await client.close();
  }
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

describe('resuming an interrupted import', () => {
  it('converges on the same database as an uninterrupted run', async () => {
    if (client === null) return;

    const cleanPath = join(workDir, 'clean.db');
    const cleanSession = await openImportSession({ ...baseOptions(cleanPath), restart: true });
    try {
      await runImportOn(cleanSession, { ...baseOptions(cleanPath), restart: true });
    } finally {
      await closeImportSession(cleanSession);
    }

    // Run one: die part-way through the assets.
    const resumedPath = join(workDir, 'resumed.db');
    const interrupted = { ...baseOptions(resumedPath), restart: true };
    const firstSession = await openImportSession(interrupted);
    let died = false;
    try {
      await runImportOn(firstSession, {
        ...interrupted,
        onProgress(progress) {
          if (progress.source === 'assets' && progress.documentsDone >= 3) {
            died = true;
            throw new Error('simulated interruption');
          }
        },
      });
    } catch (err) {
      expect(String(err)).toContain('simulated interruption');
    } finally {
      await closeImportSession(firstSession);
    }
    expect(died).toBe(true);

    // The checkpoint recorded partial progress, and only partial progress.
    const partial = new Database(resumedPath);
    const assetsCheckpoint = readCheckpoint(partial, 'assets');
    const partialAssets = (partial.query(`SELECT COUNT(*) AS n FROM assets`).get() as { n: number })
      .n;
    partial.close();
    expect(assetsCheckpoint?.completed).toBe(false);
    expect(assetsCheckpoint?.documents).toBe(3);
    expect(partialAssets).toBe(3);

    // Run two: the same command again.
    const secondSession = await openImportSession(baseOptions(resumedPath));
    let verified;
    try {
      await runImportOn(secondSession, baseOptions(resumedPath));
      verified = await verifyImport(
        secondSession.mongo,
        secondSession.sqlite,
        baseOptions(resumedPath),
      );
    } finally {
      await closeImportSession(secondSession);
    }

    expect(snapshot(resumedPath)).toEqual(snapshot(cleanPath));
    expect(assetRows(resumedPath)).toEqual(assetRows(cleanPath));
    expect(verified?.ok).toBe(true);
  }, 120_000);

  /**
   * Re-running a finished import has to stay VERIFIED.
   *
   * The documentation tells an operator to re-run after an interruption, and
   * an operator who is not sure a run finished will re-run it. The second pass
   * finds every collection complete and every reference already repaired, so
   * the question is whether the record of the FIRST pass's repairs survives —
   * verification subtracts the rows that pass dropped from the source count,
   * and an empty second answer overwriting the first made a correct database
   * report FAILED. Verifying after the second run is the part that was
   * missing; without it the regression is invisible.
   */
  it('re-running a finished import is a no-op, and still verifies', async () => {
    if (client === null) return;
    const path = join(workDir, 'twice.db');
    const options = { ...baseOptions(path), batchSize: 4 };

    const first = await openImportSession({ ...options, restart: true });
    let firstReport;
    let firstVerified;
    try {
      firstReport = await runImportOn(first, { ...options, restart: true });
      firstVerified = await verifyImport(first.mongo, first.sqlite, options);
    } finally {
      await closeImportSession(first);
    }
    const afterFirst = snapshot(path);
    expect(firstVerified?.ok).toBe(true);
    expect(firstReport?.danglingDropped).toEqual({ 'asset_locations.library_id': 1 });

    const second = await openImportSession(options);
    let report;
    let verified;
    try {
      report = await runImportOn(second, options);
      verified = await verifyImport(second.mongo, second.sqlite, options);
    } finally {
      await closeImportSession(second);
    }

    expect(snapshot(path)).toEqual(afterFirst);
    // Every collection short-circuited on its completed checkpoint.
    expect(report?.collections.every((entry) => entry.skipped)).toBe(true);
    // The first run's repair is still on the record, so the count check still
    // expects one fewer location than the source holds.
    expect(report?.danglingDropped).toEqual({ 'asset_locations.library_id': 1 });
    expect(verified?.counts.filter((entry) => !entry.ok)).toEqual([]);
    expect(verified?.ok).toBe(true);
  }, 120_000);

  /**
   * A run that dies before the end leaves the derived triggers dropped, and
   * the file says so rather than looking finished.
   */
  it('refuses to call a half-loaded database verified', async () => {
    if (client === null) return;
    const path = join(workDir, 'halted.db');
    const options = { ...baseOptions(path), restart: true };

    const session = await openImportSession(options);
    try {
      await runImportOn(session, {
        ...options,
        onProgress(progress) {
          if (progress.source === 'assets' && progress.documentsDone >= 2) {
            throw new Error('simulated interruption');
          }
        },
      });
    } catch {
      // Expected: the point is the state it leaves behind.
    }

    let verified;
    try {
      verified = await verifyImport(session.mongo, session.sqlite, options);
    } finally {
      await closeImportSession(session);
    }
    expect(verified?.derivedRestored).toBe(false);
    expect(verified?.ok).toBe(false);
  }, 120_000);
});
