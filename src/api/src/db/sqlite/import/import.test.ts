/**
 * End-to-end import against a real MongoDB (#3744).
 *
 * Uses a throwaway mongod on :27077 and a per-run database name, so it never
 * touches :27017 — a developer's real library — and never collides with another
 * suite in the same process. Skip-passes when :27077 is not running, matching
 * every other Mongo-backed suite here.
 *
 * What this file asserts is the first exit criterion: a full import completes,
 * the per-table row counts match what the source says they should be, and the
 * identifiers clients hold survive unchanged. The field-level comparison is in
 * `import-fields.test.ts` and the resumption proof is in
 * `import-resume.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MongoClient } from 'mongodb';
import { ALL_STAGE_NAMES } from '../../../workers/stages/stage-names.ts';
import { closeImportSession, openImportSession, runImportOn } from './run.ts';
import type { ImportOptions, ImportReport, VerifyReport } from './types.ts';
import { verifyImport } from './verify.ts';
import {
  connectTestMongo,
  seedLibrary,
  TEST_MONGO_URI,
  type SeedIds,
} from './seed.test-helpers.ts';

const DB_NAME = `maple_import_test_${process.pid}`;

let client: MongoClient | null = null;
let ids: SeedIds | null = null;
let report: ImportReport | null = null;
let verified: VerifyReport | null = null;
let sqlitePath = '';
let workDir = '';

/** Opens the imported database read-only for an assertion. */
function open(): Database {
  return new Database(sqlitePath, { readonly: true });
}

function count(table: string): number {
  const db = open();
  const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  db.close();
  return row.n;
}

beforeAll(async () => {
  client = await connectTestMongo();
  if (client === null) return;
  const mongo = client.db(DB_NAME);
  await mongo.dropDatabase();
  ids = await seedLibrary(mongo);

  workDir = mkdtempSync(join(tmpdir(), 'maple-import-'));
  sqlitePath = join(workDir, 'maple.db');
  const options: ImportOptions = {
    mongoUri: TEST_MONGO_URI,
    mongoDb: DB_NAME,
    sqlitePath,
    batchSize: 3,
    changesWindow: 'all',
    verifySample: 50,
    restart: true,
  };
  const session = await openImportSession(options);
  try {
    report = await runImportOn(session, options);
    verified = await verifyImport(session.mongo, session.sqlite, options);
  } finally {
    await closeImportSession(session);
  }
}, 60_000);

afterAll(async () => {
  if (client !== null) {
    await client.db(DB_NAME).dropDatabase();
    await client.close();
  }
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

describe('mongo → sqlite import', () => {
  it('skip-passes without a throwaway mongod on :27077', () => {
    if (client === null) {
      expect(client).toBeNull();
      return;
    }
    expect(report).not.toBeNull();
  });

  it('reports every table count as matching the source', () => {
    if (client === null || verified === null) return;
    const failures = verified.counts.filter((entry) => !entry.ok);
    expect(failures).toEqual([]);
  });

  it('passes verification as a whole', () => {
    if (client === null || verified === null) return;
    expect(verified.rejects).toEqual([]);
    expect(verified.foreignKeyViolations).toEqual({});
    expect(verified.fields.filter((entry) => !entry.ok)).toEqual([]);
    expect(verified.ok).toBe(true);
  });

  it('imports one row per asset, keeping the identifiers unchanged', () => {
    if (client === null || ids === null) return;
    expect(count('assets')).toBe(6);
    const db = open();
    const rows = db.query(`SELECT id FROM assets ORDER BY id`).all() as Array<{ id: string }>;
    db.close();
    const expectedIds = Object.values(ids.assets)
      .map((id) => id.toHexString())
      .sort();
    expect(rows.map((row) => row.id)).toEqual(expectedIds);
  });

  it('fans the asset arrays out into their own tables', () => {
    if (client === null) return;
    // 1 + 2 + 0 + 1 + 1 + 2, minus the one under an unregistered library root.
    expect(count('asset_locations')).toBe(6);
    expect(count('faces')).toBe(2);
    // Three links, two of which are the same (device, local id) pair.
    expect(count('asset_phasset_links')).toBe(2);
  });

  it('seeds a stage row per asset per canonical stage, plus the retired names', () => {
    if (client === null) return;
    const canonical = ALL_STAGE_NAMES.length * 6;
    // `hash` and `face` survive on the damaged asset.
    expect(count('stage_state')).toBe(canonical + 2);
    expect(report?.unknownStages).toEqual(['face', 'hash']);
  });

  it('writes a detail row only for assets that carry a payload', () => {
    if (client === null) return;
    // The rich asset and the video one; the other four carry nothing.
    expect(count('asset_detail')).toBe(2);
    expect(count('asset_search')).toBe(1);
  });

  it('derives live_location_count from the imported locations', () => {
    if (client === null || ids === null) return;
    const db = open();
    const rows = db
      .query(`SELECT id, live_location_count AS n FROM assets ORDER BY id`)
      .all() as Array<{ id: string; n: number }>;
    db.close();
    const byId = new Map(rows.map((row) => [row.id, row.n]));
    // One live location, one tagged missing.
    expect(byId.get(ids.assets.multiLocation.toHexString())).toBe(1);
    expect(byId.get(ids.assets.rich.toHexString())).toBe(1);
    // The legacy row has no locations at all.
    expect(byId.get(ids.assets.legacy.toHexString())).toBe(0);
  });

  it('rebuilds the full-text index from the imported search blobs', () => {
    if (client === null || ids === null) return;
    const db = open();
    const rows = db
      .query(
        `SELECT asset_id FROM asset_search WHERE rowid IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?)`,
      )
      .all('albany') as Array<{ asset_id: string }>;
    db.close();
    expect(rows.map((row) => row.asset_id)).toEqual([ids.assets.rich.toHexString()]);
  });

  it('drops a location whose library root was never registered, and says so', () => {
    if (client === null) return;
    expect(report?.danglingDropped).toEqual({ 'asset_locations.library_id': 1 });
  });

  it('carries the operator settings across', () => {
    if (client === null) return;
    const db = open();
    const row = db.query(`SELECT value FROM app_settings WHERE id = 'cloudflare'`).get() as {
      value: string;
    };
    db.close();
    expect(JSON.parse(row.value)).toEqual({
      config: {
        enabled: true,
        account_id: 'acct',
        bucket: 'thumbs',
        access_key_id: 'key',
        secret_access_key: 'secret',
      },
    });
  });

  it('keeps the change-log cursor counter so new cursors continue above it', () => {
    if (client === null) return;
    const db = open();
    const row = db
      .query(`SELECT seq FROM server_state WHERE id = 'asset_changes_cursor'`)
      .get() as {
      seq: number;
    };
    db.close();
    expect(row.seq).toBe(4242);
  });

  it('leaves the four deliberately-skipped collections behind', () => {
    if (client === null) return;
    const db = open();
    const tables = db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
      name: string;
    }>;
    db.close();
    const names = tables.map((row) => row.name);
    expect(names).not.toContain('migrations');
    expect(names).not.toContain('worker_status');
    expect(names).not.toContain('generated_searches');
    expect(count('image_access_tokens')).toBe(0);
  });
});
