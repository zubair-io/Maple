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
import {
  closeImportSession,
  openImportSession,
  readCheckpoint,
  runImportOn,
  verifyImport,
  type ImportOptions,
} from './index.ts';
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

  it('re-running a finished import is a no-op, not a duplication', async () => {
    if (client === null) return;
    const path = join(workDir, 'twice.db');
    const options = { ...baseOptions(path), batchSize: 4 };

    const first = await openImportSession({ ...options, restart: true });
    try {
      await runImportOn(first, { ...options, restart: true });
    } finally {
      await closeImportSession(first);
    }
    const afterFirst = snapshot(path);

    const second = await openImportSession(options);
    let report;
    try {
      report = await runImportOn(second, options);
    } finally {
      await closeImportSession(second);
    }

    expect(snapshot(path)).toEqual(afterFirst);
    // Every collection short-circuited on its completed checkpoint.
    expect(report?.collections.every((entry) => entry.skipped)).toBe(true);
  }, 120_000);
});
