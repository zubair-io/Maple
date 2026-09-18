/**
 * The three refusals and one confession the importer owes an operator (#3744).
 *
 * Each is a failure that would otherwise be quiet at exactly the moment quiet
 * is most expensive — a one-way migration of somebody's whole library:
 *
 *  - a source collection nobody has decided about, which would be left behind
 *    with nothing in the report to say so;
 *  - `--restart` pointed at the live database after a cutover, which is the
 *    same path the operator typed the first time;
 *  - a `--changes-window` a resumed run cannot honour, silently.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MongoClient } from 'mongodb';
import { closeImportSession, openImportSession, runImportOn } from './run.ts';
import type { ImportOptions } from './types.ts';
import { connectTestMongo, seedLibrary, TEST_MONGO_URI } from './seed.test-helpers.ts';

const DB_NAME = `maple_import_guards_${process.pid}`;

let client: MongoClient | null = null;
let workDir = '';

function baseOptions(sqlitePath: string): ImportOptions {
  return {
    mongoUri: TEST_MONGO_URI,
    mongoDb: DB_NAME,
    sqlitePath,
    batchSize: 50,
    changesWindow: 'all',
    verifySample: 5,
    restart: true,
  };
}

/** Imports the seeded library once into `path`, and returns the report. */
async function importInto(path: string, overrides: Partial<ImportOptions> = {}) {
  const options = { ...baseOptions(path), ...overrides };
  const session = await openImportSession(options);
  try {
    return await runImportOn(session, options);
  } finally {
    await closeImportSession(session);
  }
}

beforeAll(async () => {
  client = await connectTestMongo();
  if (client === null) return;
  await client.db(DB_NAME).dropDatabase();
  await seedLibrary(client.db(DB_NAME));
  workDir = mkdtempSync(join(tmpdir(), 'maple-import-guards-'));
}, 60_000);

afterAll(async () => {
  if (client !== null) {
    await client.db(DB_NAME).dropDatabase();
    await client.close();
  }
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

describe('source coverage', () => {
  it('imports a seeded library whose every collection is accounted for', async () => {
    if (client === null) return;
    const report = await importInto(join(workDir, 'covered.db'));
    expect(report.collections.length).toBeGreaterThan(0);
  }, 60_000);

  /**
   * The regression this check exists for: five collections a live install
   * carries had no plan, no entry in the skipped list and no mention in the
   * report, and no amount of running the importer could reveal it. Now the
   * source database is asked what it holds.
   */
  it('refuses to start when the source holds a collection nobody has decided about', async () => {
    if (client === null) return;
    await client
      .db(DB_NAME)
      .collection('weather_notes')
      .insertOne({ note: 'rained' } as never);
    try {
      await expect(importInto(join(workDir, 'uncovered.db'))).rejects.toThrow('weather_notes');
    } finally {
      await client.db(DB_NAME).collection('weather_notes').drop();
    }
  }, 60_000);
});

describe('--restart', () => {
  it('deletes a database this importer produced, journals and all', async () => {
    if (client === null) return;
    const path = join(workDir, 'restartable.db');
    await importInto(path);
    writeFileSync(`${path}-wal`, 'stale journal');
    writeFileSync(`${path}-shm`, 'stale index');

    const session = await openImportSession(baseOptions(path));
    await closeImportSession(session);
    // The importer's own -wal is recreated by the new session; the stale
    // content is what had to go, and a checkpoint from the previous run must
    // not have survived into it.
    const db = new Database(path, { readonly: true });
    const rows = (db.query(`SELECT COUNT(*) AS n FROM import_checkpoint`).get() as { n: number }).n;
    db.close();
    expect(rows).toBe(0);
  }, 60_000);

  it('refuses to delete a file that carries no importer bookkeeping', async () => {
    if (client === null) return;
    const path = join(workDir, 'live.db');
    const live = new Database(path, { create: true });
    live.exec(`CREATE TABLE assets (id TEXT PRIMARY KEY)`);
    live.exec(`INSERT INTO assets (id) VALUES ('irreplaceable')`);
    live.close();

    await expect(openImportSession(baseOptions(path))).rejects.toThrow('will not delete');
    expect(existsSync(path)).toBe(true);
    const db = new Database(path, { readonly: true });
    const kept = (db.query(`SELECT COUNT(*) AS n FROM assets`).get() as { n: number }).n;
    db.close();
    expect(kept).toBe(1);
  }, 60_000);
});

describe('--changes-window on a resumed run', () => {
  it('says so when the window it was given is not the one in effect', async () => {
    if (client === null) return;
    const path = join(workDir, 'window.db');
    const first = await importInto(path, { changesWindow: 1 });
    expect(first.windowOverrides).toEqual([]);

    const second = await importInto(path, { changesWindow: 'all', restart: false });
    expect(second.windowOverrides).toEqual([
      { source: 'asset_changes', requested: 'all', inEffect: '1' },
    ]);
  }, 60_000);
});
