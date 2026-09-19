/**
 * The relocate write path.
 *
 * Two of these three functions exist because of a specific failure, and the
 * tests are organised around those failures rather than around the statements.
 *
 * `repointAssetLocation` runs between a verified copy and the delete of the
 * original, so what matters is not only that it moves the row but that it
 * refuses to when the row is no longer the one the caller read. A repoint that
 * matched on the asset id alone would write nothing useful and report success,
 * and the caller would then delete an original whose catalogue entry still
 * pointed at it.
 *
 * `findLiveOccupantAssetId` guards `collision: 'replace'`, which is the one
 * policy that publishes over whatever sits at the destination. Replacing an
 * untracked file is the legitimate case; replacing a tracked asset's bytes is
 * silent data loss (#2843).
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
  type TestDatabase,
} from '../test-sqlite.test-helpers.ts';
import {
  findLiveOccupantAssetId,
  recordSidecarEditAtAddress,
  repointAssetLocation,
} from './assets.relocate.repo.ts';

const oid = (hex: string): ObjectId => new ObjectId(hex);

function stageRow(handle: TestDatabase, assetId: string, stage: string) {
  return handle.db
    .query(
      `SELECT version, attempts, last_error, processed_at, dead
         FROM stage_state WHERE asset_id = ? AND stage = ?`,
    )
    .get(assetId, stage) as Record<string, unknown> | null;
}

function locationRows(handle: TestDatabase, assetId: string) {
  return handle.db
    .query(
      `SELECT ordinal, library_id, path, filename, missing_since, missing_reason
         FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`,
    )
    .all(assetId) as Array<Record<string, unknown>>;
}

describe('findLiveOccupantAssetId', () => {
  test('reports the live asset that already holds the address', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const occupant = insertAsset(handle.db);
    insertLocation(handle.db, { assetId: occupant, libraryId, path: 'a', filename: 'x.dng' });

    const found = await findLiveOccupantAssetId(
      { libraryId: oid(libraryId), path: 'a', filename: 'x.dng' },
      new ObjectId(),
      db,
    );

    expect(found).toBe(occupant);
  });

  test('the asset being relocated never counts as its own occupant', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, { assetId, libraryId, path: 'a', filename: 'x.dng' });

    expect(
      await findLiveOccupantAssetId(
        { libraryId: oid(libraryId), path: 'a', filename: 'x.dng' },
        oid(assetId),
        db,
      ),
    ).toBeNull();
  });

  test('a trashed asset, a tombstoned entry and a free address are all unoccupied', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);

    const trashed = insertAsset(handle.db, { deletedAt: '2026-01-01T00:00:00.000Z' });
    insertLocation(handle.db, { assetId: trashed, libraryId, path: 'a', filename: 'trashed.dng' });
    const tombstoned = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId: tombstoned,
      libraryId,
      path: 'a',
      filename: 'replaced.dng',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });

    const at = (filename: string) =>
      findLiveOccupantAssetId(
        { libraryId: oid(libraryId), path: 'a', filename },
        new ObjectId(),
        db,
      );

    expect(await at('trashed.dng')).toBeNull();
    expect(await at('replaced.dng')).toBeNull();
    expect(await at('nothing-here.dng')).toBeNull();
  });
});

describe('repointAssetLocation', () => {
  /** An asset at `a/x.dng` whose caches and search row are already up to date. */
  function seedRelocatable(handle: TestDatabase, libraryId: string): string {
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId,
      libraryId,
      path: 'a',
      filename: 'x.dng',
      missingSince: '2026-01-01T00:00:00.000Z',
    });
    run(
      handle.db,
      `UPDATE asset_locations SET missing_reason = 'enoent' WHERE asset_id = ?`,
      assetId,
    );
    for (const stage of ['meili', 'thumb', 'preview']) {
      run(
        handle.db,
        `INSERT INTO stage_state (asset_id, stage, version, attempts, last_error, processed_at, dead)
         VALUES (?, ?, 4, 3, 'boom', '2026-01-01T00:00:00.000Z', 1)`,
        assetId,
        stage,
      );
    }
    return assetId;
  }

  test('moves onto an address a reaped row still claims, and leaves that row assetless', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = seedRelocatable(handle, libraryId);

    // The state the missing-reaper leaves behind: an asset soft-deleted because
    // its file vanished, whose location was never repointed and so goes on
    // naming the address the file used to have. `asset_locations_lib_path_name`
    // is UNIQUE and not partial over live rows, so that dead row reserves the
    // address against everyone.
    const reaped = insertAsset(handle.db, { deletedAt: '2026-01-02T00:00:00.000Z' });
    insertLocation(handle.db, {
      assetId: reaped,
      libraryId,
      path: 'b',
      filename: 'y.dng',
      deletedAt: '2026-01-02T00:00:00.000Z',
    });

    // Before #3787 this threw on the unique index, and the caller reported
    // "fileinfo entry changed concurrently" — a 500 with an untrue explanation
    // for a move MongoDB completed, because it had no such constraint.
    expect(
      await repointAssetLocation(
        {
          id: oid(assetId),
          from: { libraryId: oid(libraryId), path: 'a', filename: 'x.dng' },
          to: { libraryId: oid(libraryId), path: 'b', filename: 'y.dng' },
        },
        db,
      ),
    ).toBe(true);

    expect(
      handle.db.query(`SELECT path, filename FROM asset_locations WHERE asset_id = ?`).get(assetId),
    ).toEqual({ path: 'b', filename: 'y.dng' });
    // The reaped asset keeps its row; only its stale claim on the address goes.
    expect(
      handle.db.query(`SELECT COUNT(*) AS n FROM asset_locations WHERE asset_id = ?`).get(reaped),
    ).toEqual({ n: 0 });
    expect(handle.db.query(`SELECT id FROM assets WHERE id = ?`).get(reaped)).toEqual({
      id: reaped,
    });
  });

  test('still refuses to evict a LIVE occupant of the destination', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = seedRelocatable(handle, libraryId);

    const occupant = insertAsset(handle.db);
    insertLocation(handle.db, { assetId: occupant, libraryId, path: 'b', filename: 'y.dng' });

    // The dead-claim sweep is scoped to `deleted_at IS NOT NULL` precisely so
    // this case keeps failing. A live occupant is what the caller's `occupied`
    // result exists to report, and quietly evicting it would be the silent data
    // loss that guard was added to prevent.
    await expect(
      repointAssetLocation(
        {
          id: oid(assetId),
          from: { libraryId: oid(libraryId), path: 'a', filename: 'x.dng' },
          to: { libraryId: oid(libraryId), path: 'b', filename: 'y.dng' },
        },
        db,
      ),
    ).rejects.toThrow();
    expect(
      handle.db
        .query(`SELECT asset_id FROM asset_locations WHERE path = ? AND filename = ?`)
        .get('b', 'y.dng'),
    ).toEqual({ asset_id: occupant });
  });

  test('moves the entry, clears its missing tags, and re-arms the path-keyed stages', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = seedRelocatable(handle, libraryId);

    const repointed = await repointAssetLocation(
      {
        id: oid(assetId),
        from: { libraryId: oid(libraryId), path: 'a', filename: 'x.dng' },
        to: { libraryId: oid(libraryId), path: 'b/c', filename: 'renamed.dng' },
      },
      db,
    );

    expect(repointed).toBe(true);
    expect(locationRows(handle, assetId)).toEqual([
      {
        ordinal: 0,
        library_id: libraryId,
        path: 'b/c',
        filename: 'renamed.dng',
        missing_since: null,
        missing_reason: null,
      },
    ]);

    // meili clears processed_at; the two cache stages keep theirs.
    expect(stageRow(handle, assetId, 'meili')).toEqual({
      version: 0,
      attempts: 0,
      last_error: null,
      processed_at: null,
      dead: 0,
    });
    for (const stage of ['thumb', 'preview']) {
      expect(stageRow(handle, assetId, stage)).toEqual({
        version: 0,
        attempts: 0,
        last_error: null,
        processed_at: '2026-01-01T00:00:00.000Z',
        dead: 0,
      });
    }
  });

  test('re-arms a stage that has no row yet', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, { assetId, libraryId, path: 'a', filename: 'x.dng' });

    await repointAssetLocation(
      {
        id: oid(assetId),
        from: { libraryId: oid(libraryId), path: 'a', filename: 'x.dng' },
        to: { libraryId: oid(libraryId), path: 'b', filename: 'x.dng' },
      },
      db,
    );

    expect(stageRow(handle, assetId, 'thumb')).not.toBeNull();
  });

  test('a stale source address matches nothing, so the caller can abort', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, { assetId, libraryId, path: 'moved-already', filename: 'x.dng' });

    const repointed = await repointAssetLocation(
      {
        id: oid(assetId),
        from: { libraryId: oid(libraryId), path: 'a', filename: 'x.dng' },
        to: { libraryId: oid(libraryId), path: 'b', filename: 'x.dng' },
      },
      db,
    );

    expect(repointed).toBe(false);
    expect(locationRows(handle, assetId)[0]?.path).toBe('moved-already');
  });

  test('a cross-library move repoints library_id and leaves the other entries alone', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const source = insertFolder(handle.db);
    const destination = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId,
      libraryId: source,
      ordinal: 0,
      path: 'a',
      filename: 'x.dng',
    });
    insertLocation(handle.db, {
      assetId,
      libraryId: destination,
      ordinal: 1,
      path: 'untouched',
      filename: 'y.dng',
    });

    await repointAssetLocation(
      {
        id: oid(assetId),
        from: { libraryId: oid(source), path: 'a', filename: 'x.dng' },
        to: { libraryId: oid(destination), path: 'moved', filename: 'x.dng' },
      },
      db,
    );

    const rows = locationRows(handle, assetId);
    expect(rows[0]).toMatchObject({ library_id: destination, path: 'moved', filename: 'x.dng' });
    expect(rows[1]).toMatchObject({
      library_id: destination,
      path: 'untouched',
      filename: 'y.dng',
    });
  });

  test('a tombstoned entry at the source address is not repointed', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId,
      libraryId,
      path: 'a',
      filename: 'x.dng',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });

    const repointed = await repointAssetLocation(
      {
        id: oid(assetId),
        from: { libraryId: oid(libraryId), path: 'a', filename: 'x.dng' },
        to: { libraryId: oid(libraryId), path: 'b', filename: 'x.dng' },
      },
      db,
    );

    expect(repointed).toBe(false);
  });

  test('apple_rendered_path is written only when a companion actually moved', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, { assetId, libraryId, path: 'a', filename: 'x.dng' });
    run(handle.db, `UPDATE assets SET apple_rendered_path = 'a/x.jpg' WHERE id = ?`, assetId);

    const rendered = () =>
      handle.db.query(`SELECT apple_rendered_path AS p FROM assets WHERE id = ?`).get(assetId);

    // No companion supplied: the stored value survives untouched.
    await repointAssetLocation(
      {
        id: oid(assetId),
        from: { libraryId: oid(libraryId), path: 'a', filename: 'x.dng' },
        to: { libraryId: oid(libraryId), path: 'b', filename: 'x.dng' },
      },
      db,
    );
    expect(rendered()).toEqual({ p: 'a/x.jpg' });

    await repointAssetLocation(
      {
        id: oid(assetId),
        from: { libraryId: oid(libraryId), path: 'b', filename: 'x.dng' },
        to: { libraryId: oid(libraryId), path: 'c', filename: 'x.dng' },
        appleRenderedPath: 'c/x.jpg',
      },
      db,
    );
    expect(rendered()).toEqual({ p: 'c/x.jpg' });
  });
});

describe('recordSidecarEditAtAddress', () => {
  test('bumps the edit counter and reports which asset it was', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, { assetId, libraryId, path: 'a', filename: 'x.dng' });

    const found = await recordSidecarEditAtAddress(
      { libraryId: oid(libraryId), path: 'a', filename: 'x.dng' },
      db,
    );

    expect(found?.toHexString()).toBe(assetId);
    expect(
      handle.db.query(`SELECT has_xmp, sidecar_ver FROM assets WHERE id = ?`).get(assetId),
    ).toEqual({ has_xmp: 1, sidecar_ver: 1 });
  });

  test('an unknown or tombstoned address bumps nothing and reports null', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId,
      libraryId,
      path: 'a',
      filename: 'x.dng',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(
      await recordSidecarEditAtAddress(
        { libraryId: oid(libraryId), path: 'a', filename: 'x.dng' },
        db,
      ),
    ).toBeNull();
    expect(
      await recordSidecarEditAtAddress(
        { libraryId: oid(libraryId), path: 'nowhere', filename: 'x.dng' },
        db,
      ),
    ).toBeNull();
    expect(handle.db.query(`SELECT sidecar_ver FROM assets WHERE id = ?`).get(assetId)).toEqual({
      sidecar_ver: 0,
    });
  });
});
