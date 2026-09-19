/**
 * The indexer's skeleton upsert, against rows.
 *
 * The behaviour under test is the one Phase 1 of `docs/indexer-enrichment.md`
 * promises: a re-upsert refreshes the fast-tier stat fields and touches nothing
 * a worker owns. On Mongo that was a `$set` / `$setOnInsert` split whose
 * correctness had to be asserted field by field. Most of those fields are now
 * columns with defaults, separate tables, or a trigger-derived value, so what is
 * left to prove is narrower and sharper: the identity is `maple_id`, the stat
 * fields move, the enrichment side-tables do not, and the location is seeded
 * exactly once.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../../object-id.ts';
import {
  createTestDatabase,
  insertFolder,
  liveLocationCount,
  run,
  testSqliteDb,
} from '../test-sqlite.test-helpers.ts';
import { upsertAssetByMapleId } from './assets.upsert.ts';

const MAPLE_ID = 'aa'.repeat(16);

function baseInput(libraryId: string) {
  return {
    libraryId: new ObjectId(libraryId),
    relDir: '2024/03',
    filename: 'IMG_0001.dng',
    size: 1_024,
    mtime: 1_700_000_000_000,
    mapleId: MAPLE_ID,
    sha1Head: 'b'.repeat(40),
  };
}

function assetRow(db: Parameters<typeof liveLocationCount>[0], id: string) {
  return db
    .query(
      `SELECT size, mtime, indexed_at, sha1_head, deleted_at, rating, flag, color_label,
              exif, place, maple_id
         FROM assets WHERE id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

describe('upsertAssetByMapleId', () => {
  test('inserts the asset, its first location and nothing else', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);

    const { id } = await upsertAssetByMapleId(baseInput(libraryId), () => new Date(0), db);

    const row = assetRow(handle.db, id.toHexString());
    expect(row.maple_id).toBe(MAPLE_ID);
    expect(row.size).toBe(1_024);
    expect(row.sha1_head).toBe('b'.repeat(40));
    expect(row.deleted_at).toBeNull();
    // Seeded by the column defaults rather than by a `$setOnInsert`.
    expect(row.rating).toBe(0);
    expect(row.flag).toBe(0);
    expect(row.color_label).toBe('');
    // Never ran exif, so the column must not have been written.
    expect(row.exif).toBeNull();
    expect(row.place).toBeNull();

    const locations = handle.db
      .query(`SELECT ordinal, library_id, path, filename, deleted_at FROM asset_locations`)
      .all() as Array<Record<string, unknown>>;
    expect(locations).toEqual([
      {
        ordinal: 0,
        library_id: libraryId,
        path: '2024/03',
        filename: 'IMG_0001.dng',
        deleted_at: null,
      },
    ]);
    // The trigger derives the roll-up; the upsert never writes it.
    expect(liveLocationCount(handle.db, id.toHexString())).toBe(1);
  });

  test('a re-upsert refreshes the stat fields and reuses the same row', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const input = baseInput(libraryId);

    const first = await upsertAssetByMapleId(input, () => new Date(0), db);
    const second = await upsertAssetByMapleId(
      { ...input, size: 2_048, mtime: 1_800_000_000_000, sha1Head: 'c'.repeat(40) },
      () => new Date(1_000),
      db,
    );

    expect(second.id.toHexString()).toBe(first.id.toHexString());
    const row = assetRow(handle.db, first.id.toHexString());
    expect(row.size).toBe(2_048);
    expect(row.mtime).toBe(1_800_000_000_000);
    expect(row.sha1_head).toBe('c'.repeat(40));
    expect(row.indexed_at).toBe(new Date(1_000).toISOString());
    expect(handle.db.query(`SELECT COUNT(*) AS n FROM assets`).get()).toEqual({ n: 1 });
  });

  test('a re-upsert clears a soft delete, because the file is back on disk', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const input = baseInput(libraryId);

    const { id } = await upsertAssetByMapleId(input, () => new Date(0), db);
    run(
      handle.db,
      `UPDATE assets SET deleted_at = ? WHERE id = ?`,
      '2026-01-01T00:00:00.000Z',
      id.toHexString(),
    );

    await upsertAssetByMapleId(input, () => new Date(0), db);
    expect(assetRow(handle.db, id.toHexString()).deleted_at).toBeNull();
  });

  test('a re-upsert never clobbers what an enrichment worker wrote', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const input = baseInput(libraryId);

    const { id } = await upsertAssetByMapleId(input, () => new Date(0), db);
    const hex = id.toHexString();
    run(
      handle.db,
      `UPDATE assets SET place = ? WHERE id = ?`,
      '{"rollups":{"locality":"Kyoto"}}',
      hex,
    );
    run(
      handle.db,
      `INSERT INTO asset_detail (asset_id, description) VALUES (?, ?)`,
      hex,
      'a temple at dusk',
    );

    await upsertAssetByMapleId({ ...input, size: 4_096 }, () => new Date(0), db);

    expect(assetRow(handle.db, hex).place).toBe('{"rollups":{"locality":"Kyoto"}}');
    expect(
      handle.db.query(`SELECT description FROM asset_detail WHERE asset_id = ?`).get(hex),
    ).toEqual({
      description: 'a temple at dusk',
    });
  });

  test('an omitted exif leaves a stored payload alone; an explicit null clears it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const input = baseInput(libraryId);
    const exif = { captured_at: '2024-03-01T10:00:00.000Z' } as never;

    const { id } = await upsertAssetByMapleId({ ...input, exif }, () => new Date(0), db);
    const hex = id.toHexString();
    expect(JSON.parse(String(assetRow(handle.db, hex).exif))).toEqual({
      captured_at: '2024-03-01T10:00:00.000Z',
    });

    // Undefined means "did not run", which must not clear the stored value.
    await upsertAssetByMapleId(input, () => new Date(0), db);
    expect(assetRow(handle.db, hex).exif).not.toBeNull();

    // Null means "ran, found nothing", which is a value worth storing.
    await upsertAssetByMapleId({ ...input, exif: null }, () => new Date(0), db);
    expect(assetRow(handle.db, hex).exif).toBeNull();
  });

  test('the location is seeded once, and a later move is not undone', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const input = baseInput(libraryId);

    const { id } = await upsertAssetByMapleId(input, () => new Date(0), db);
    const hex = id.toHexString();
    // The discover watcher owns the array from the first insert onwards.
    run(handle.db, `UPDATE asset_locations SET path = ? WHERE asset_id = ?`, '2024/04', hex);

    await upsertAssetByMapleId(input, () => new Date(0), db);

    expect(handle.db.query(`SELECT path FROM asset_locations WHERE asset_id = ?`).all(hex)).toEqual(
      [{ path: '2024/04' }],
    );
  });

  test('the same content found at a second path does not grow a second entry', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const input = baseInput(libraryId);

    const { id } = await upsertAssetByMapleId(input, () => new Date(0), db);
    // Discovering a duplicate is the watcher's business, not the upsert's:
    // adding a location here would put an `ordinal = 0` sibling beside the
    // canonical entry and make "the first location" ambiguous.
    await upsertAssetByMapleId(
      { ...input, relDir: 'elsewhere', filename: 'copy.dng' },
      () => new Date(0),
      db,
    );

    expect(
      handle.db
        .query(`SELECT ordinal, path, filename FROM asset_locations WHERE asset_id = ?`)
        .all(id.toHexString()),
    ).toEqual([{ ordinal: 0, path: '2024/03', filename: 'IMG_0001.dng' }]);
  });

  test('two different files cannot claim one path', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const input = baseInput(libraryId);

    await upsertAssetByMapleId(input, () => new Date(0), db);
    // A second content identity at the same address: the asset row is created,
    // and the location insert is refused by the UNIQUE address index rather
    // than stealing the first asset's file.
    const other = await upsertAssetByMapleId(
      { ...input, mapleId: 'dd'.repeat(16) },
      () => new Date(0),
      db,
    );

    expect(handle.db.query(`SELECT COUNT(*) AS n FROM asset_locations`).get()).toEqual({ n: 1 });
    expect(liveLocationCount(handle.db, other.id.toHexString())).toBe(0);
  });
});
