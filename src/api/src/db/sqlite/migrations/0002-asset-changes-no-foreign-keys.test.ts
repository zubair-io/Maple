/**
 * The repair migration, driven against a database that still carries the keys.
 *
 * The bug it exists for is invisible from a fresh database, because a fresh one
 * is built from DDL that no longer declares the keys. Every assertion here
 * therefore starts by winding the schema back to what `0001-initial-schema`
 * shipped — which is the state every developer and CI database that ran 0001
 * before #3747 is actually in, since the runner skips a recorded id without
 * looking at what it now declares.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from 'mongodb';
import { ASSET_CHANGES_INDEX_DDL } from '../ddl/library.ts';
import { fromBunSqlite, runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { recordAssetChange } from '../repos/changes.repo.ts';
import {
  createTestDatabase,
  insertAsset,
  run,
  testSqliteDb,
  type TestDatabase,
} from '../test-sqlite.test-helpers.ts';

/** `asset_changes` exactly as `0001-initial-schema` created it. */
const ASSET_CHANGES_WITH_KEYS_DDL = `
CREATE TABLE asset_changes (
  cursor INTEGER NOT NULL PRIMARY KEY,

  asset_id  TEXT REFERENCES assets (id) ON DELETE SET NULL,
  folder_id TEXT REFERENCES folders (id) ON DELETE SET NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('create', 'update', 'delete', 'restore')),

  abs_path      TEXT,
  relative_path TEXT,
  at            TEXT NOT NULL
);
`;

/** Puts the database back in the state 0001 left it, with 0002 unrecorded. */
function windBackTo0001(handle: TestDatabase): void {
  run(handle.db, `DROP TABLE asset_changes`);
  handle.db.exec(ASSET_CHANGES_WITH_KEYS_DDL);
  handle.db.exec(ASSET_CHANGES_INDEX_DDL);
  run(handle.db, `DELETE FROM schema_migrations WHERE id = ?`, ALL_MIGRATIONS[1]!.id);
}

function foreignKeys(db: Database): unknown[] {
  return db.query(`PRAGMA foreign_key_list('asset_changes')`).all();
}

function indexNames(db: Database): string[] {
  const rows = db
    .query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'asset_changes'`)
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name).sort();
}

describe('0002-asset-changes-no-foreign-keys', () => {
  test('drops the keys from a database that still has them', async () => {
    using handle = await createTestDatabase();
    windBackTo0001(handle);
    expect(foreignKeys(handle.db)).toHaveLength(2);

    const result = await runMigrations(fromBunSqlite(handle.db), ALL_MIGRATIONS);

    expect(result.applied).toEqual(['0002-asset-changes-no-foreign-keys']);
    expect(foreignKeys(handle.db)).toHaveLength(0);
    expect(indexNames(handle.db)).toEqual(['asset_changes_asset', 'asset_changes_folder_cursor']);
  });

  test('keeps the journal, because the cursor is the client sync anchor', async () => {
    using handle = await createTestDatabase();
    windBackTo0001(handle);
    const assetId = insertAsset(handle.db);
    for (const cursor of [7, 8, 9]) {
      run(
        handle.db,
        `INSERT INTO asset_changes (cursor, asset_id, kind, abs_path, at)
         VALUES (?, ?, 'update', ?, ?)`,
        cursor,
        assetId,
        `/srv/photos/${cursor}.dng`,
        new Date().toISOString(),
      );
    }

    await runMigrations(fromBunSqlite(handle.db), ALL_MIGRATIONS);

    const rows = handle.db
      .query(`SELECT cursor, asset_id, abs_path FROM asset_changes ORDER BY cursor`)
      .all() as Array<{ cursor: number; asset_id: string; abs_path: string }>;
    expect(rows.map((row) => row.cursor)).toEqual([7, 8, 9]);
    expect(rows.every((row) => row.asset_id === assetId)).toBe(true);
    expect(rows[0]!.abs_path).toBe('/srv/photos/7.dng');
  });

  test('the delete event the key used to reject now lands', async () => {
    using handle = await createTestDatabase();
    windBackTo0001(handle);
    const db = testSqliteDb(handle.db);
    const assetId = insertAsset(handle.db);
    run(handle.db, `DELETE FROM assets WHERE id = ?`, assetId);

    // This is the whole point: `routes/assets/trash.ts` writes the delete event
    // after `hardDelete` has removed the asset, so under 0001's schema the key
    // rejects the insert and the best-effort handler swallows it — the File
    // Provider extension never learns which item to drop.
    const input = {
      kind: 'delete' as const,
      asset_id: new ObjectId(assetId),
      folder_id: null,
      abs_path: '/srv/photos/gone.dng',
    };
    await expect(recordAssetChange(db, input)).rejects.toThrow(/FOREIGN KEY/i);

    await runMigrations(fromBunSqlite(handle.db), ALL_MIGRATIONS);

    expect(await recordAssetChange(db, input)).toBe(1);
  });

  test('is a no-op on a database built from the current schema', async () => {
    using handle = await createTestDatabase();
    // createTestDatabase already ran the whole list, so a second run has
    // nothing to do and the conditional never reaches the rebuild.
    const result = await runMigrations(fromBunSqlite(handle.db), ALL_MIGRATIONS);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContain('0002-asset-changes-no-foreign-keys');
    expect(foreignKeys(handle.db)).toHaveLength(0);
  });
});
