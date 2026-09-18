/**
 * The ported read verbs, against a real database.
 *
 * What these cover is the half of the port a type checker cannot: that each
 * function assembles the same DTO from five tables that the Mongo one
 * assembled from one document, and that the two defects the ticket names are
 * actually fixed rather than moved.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  findCoreInfoById,
  findDetailByAddress,
  findDetailById,
  findDetailsByIds,
  findListItems,
  findLiveAssetIdByMapleId,
  findLiveAssetIdByPhassetLink,
  parseAssetId,
} from './assets.repo.ts';
import {
  insertDetail,
  insertEnrichmentState,
  insertFace,
  insertPerson,
  insertPhassetLink,
  testSqliteDb,
} from './assets.test-helpers.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../test-sqlite.test-helpers.ts';
import type { SqlParams } from '../protocol.ts';
import type { SqliteDb } from './db-handle.ts';

const oid = (hex: string): ObjectId => new ObjectId(hex);

/**
 * The same handle, except that reading the library roots fails — the transient
 * hiccup the transform path has to survive rather than propagate.
 */
function withFailingLibraryRead(db: SqliteDb): SqliteDb {
  return {
    ...db,
    read: async <T>(sql: string, params?: SqlParams): Promise<T[]> => {
      if (sql.includes('FROM folders')) throw new Error('folders unavailable');
      return db.read<T>(sql, params);
    },
  };
}

describe('parseAssetId', () => {
  test('parses a 24-character hex id and rejects anything else', () => {
    const id = new ObjectId();
    expect(parseAssetId(id.toHexString())?.toHexString()).toBe(id.toHexString());
    expect(parseAssetId('not-an-id')).toBeNull();
    expect(parseAssetId('')).toBeNull();
  });
});

describe('findDetailById', () => {
  test('assembles the detail DTO from every table that feeds it', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const sql = testSqliteDb(db);

    const libraryId = insertFolder(db, { path: '/libraries/main' });
    const assetId = insertAsset(db, {
      exif: JSON.stringify({ captured_at: '2026-04-01T10:00:00Z', captured_month: 4 }),
      place: JSON.stringify({ rollups: { locality: 'Brooklyn' }, search_blob: 'brooklyn' }),
    });
    insertLocation(db, { assetId, libraryId, path: 'vacation/2024', filename: 'IMG_1.dng' });
    run(
      db,
      `UPDATE assets SET rating = 4, flag = 1, color_label = 'red', has_xmp = 1,
         sidecar_ver = 3, is_screenshot = 1, size = 2048, mtime = 1700000000000
       WHERE id = ?`,
      assetId,
    );
    insertDetail(db, assetId, {
      description: 'a boat',
      ocrText: 'SEA',
      vision: JSON.stringify({ scene_type: 'outdoor' }),
      transcript: JSON.stringify({
        text: 'hello',
        language: 'en',
        model: 'whisper',
        duration_sec: 2,
        generated_at: '2026-04-02T00:00:00Z',
        segments: [{ start: 0, end: 2, text: 'hello' }],
      }),
    });
    const personId = insertPerson(db, 'Maya');
    insertFace(db, { assetId, faceIndex: 0, personId, embedding: JSON.stringify([0.1, 0.2]) });
    insertFace(db, { assetId, faceIndex: 1, personId: null });
    insertEnrichmentState(db, assetId, 'geocode', { doneAt: '2026-04-01T11:00:00Z', version: 2 });

    const dto = await findDetailById(oid(assetId), sql);

    expect(dto).not.toBeNull();
    expect(dto!.id).toBe(assetId);
    expect(dto!.folder_id).toBe(libraryId);
    expect(dto!.filename).toBe('IMG_1.dng');
    expect(dto!.abs_path).toBe('/libraries/main/vacation/2024/IMG_1.dng');
    expect(dto!.size).toBe(2048);
    expect(dto!.mtime).toBe(1_700_000_000_000);
    expect(dto!.rating).toBe(4);
    expect(dto!.flag).toBe(1);
    expect(dto!.color_label).toBe('red');
    expect(dto!.sidecar_ver).toBe(3);
    expect(dto!.is_screenshot).toBe(true);
    expect(dto!.place?.rollups.locality).toBe('Brooklyn');
    expect(dto!.description).toBe('a boat');
    expect(dto!.ocr_text).toBe('SEA');
    expect(dto!.vision).toEqual({ scene_type: 'outdoor' });
    // The display projection drops the per-segment timings.
    expect(dto!.transcript).toEqual({
      text: 'hello',
      language: 'en',
      model: 'whisper',
      duration_sec: 2,
      generated_at: '2026-04-02T00:00:00Z',
    });
    expect(dto!.faces).toHaveLength(2);
    expect(dto!.faces[0]!.name).toBe('Maya');
    expect(dto!.faces[0]!.person_id).toBe(personId);
    expect(dto!.faces[0]!.embedding).toEqual([0.1, 0.2]);
    expect(dto!.faces[1]!.name).toBeNull();
    // An absent embedding is an absent key, not an explicit null.
    expect('embedding' in dto!.faces[1]!).toBe(false);
    expect(dto!.enrichment.geocode.done_at).toBe('2026-04-01T11:00:00Z');
    expect(dto!.enrichment.geocode.version).toBe(2);
    // A stage with no row reads as pending, exactly like a missing subdocument.
    expect(dto!.enrichment.describe).toEqual({
      done_at: null,
      locked_by: null,
      lease_expires_at: null,
      attempts: 0,
      last_error: null,
      version: null,
      dead_letter_at: null,
    });
  });

  test('cannot carry a face whose person is not a real row, so no name lookup can miss', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId });
    const personId = insertPerson(db, 'Greyson');
    // The Mongo repo has to canonicalise the id's case and drop malformed hex
    // before its `$in`; the foreign key makes both defences unnecessary here.
    expect(() => insertFace(db, { assetId, personId: personId.toUpperCase() })).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    insertFace(db, { assetId, personId });
    const dto = await findDetailById(oid(assetId), testSqliteDb(db));
    expect(dto!.faces[0]!.name).toBe('Greyson');
  });

  test('returns null for an unknown id', async () => {
    using handle = await createTestDatabase();
    expect(await findDetailById(new ObjectId(), testSqliteDb(handle.db))).toBeNull();
  });

  test('still answers with an empty abs_path when the library roots cannot be read', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { path: '/libraries/main' });
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, path: '', filename: 'root.dng' });

    const dto = await findDetailById(oid(assetId), withFailingLibraryRead(testSqliteDb(db)));
    expect(dto!.abs_path).toBe('');
    expect(dto!.folder_id).toBe(libraryId);
    expect(dto!.filename).toBe('root.dng');
  });
});

describe('findDetailsByIds', () => {
  test('resolves a batch in one pass and omits unknown ids', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const first = insertAsset(db);
    const second = insertAsset(db);
    insertLocation(db, { assetId: first, libraryId, filename: 'a.dng' });
    insertLocation(db, { assetId: second, libraryId, filename: 'b.dng' });
    const personId = insertPerson(db, 'Ada');
    insertFace(db, { assetId: second, personId });

    const dtos = await findDetailsByIds(
      [oid(first), oid(second), new ObjectId()],
      testSqliteDb(db),
    );
    expect(dtos.map((d) => d.id).sort()).toEqual([first, second].sort());
    const secondDto = dtos.find((d) => d.id === second);
    expect(secondDto!.faces[0]!.name).toBe('Ada');
  });

  test('returns an empty array for an empty id list without touching the database', async () => {
    expect(await findDetailsByIds([])).toEqual([]);
  });
});

describe('findDetailByAddress', () => {
  test('resolves an asset by library, directory and filename', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { path: '/libraries/main' });
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, path: 'vacation/2024', filename: 'IMG_1.dng' });

    const dto = await findDetailByAddress(
      oid(libraryId),
      'vacation/2024/IMG_1.dng',
      testSqliteDb(db),
    );
    expect(dto!.id).toBe(assetId);
  });

  test('resolves a file at the library root, with or without a leading slash', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const sql = testSqliteDb(db);
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, path: '', filename: 'root.dng' });

    expect((await findDetailByAddress(oid(libraryId), 'root.dng', sql))!.id).toBe(assetId);
    expect((await findDetailByAddress(oid(libraryId), '/root.dng', sql))!.id).toBe(assetId);
  });

  test('is scoped to the library, so the same relative path elsewhere never collides', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryA = insertFolder(db, { path: '/libraries/a', slug: 'a' });
    const libraryB = insertFolder(db, { path: '/libraries/b', slug: 'b' });
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId: libraryA, path: 'x', filename: 'same.dng' });

    expect(await findDetailByAddress(oid(libraryB), 'x/same.dng', testSqliteDb(db))).toBeNull();
  });

  test('rejects an address with no filename', async () => {
    using handle = await createTestDatabase();
    const libraryId = insertFolder(handle.db);
    expect(await findDetailByAddress(oid(libraryId), 'x/', testSqliteDb(handle.db))).toBeNull();
  });
});

describe('findCoreInfoById', () => {
  test('carries the fields the trash and change-feed paths read', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { path: '/libraries/main' });
    const assetId = insertAsset(db, {
      exif: JSON.stringify({ iso: 400 }),
      deletedAt: '2026-04-05T00:00:00Z',
    });
    insertLocation(db, { assetId, libraryId, path: '', filename: 'gone.dng' });
    insertDetail(db, assetId, { description: 'caption', ocrText: 'TEXT' });
    run(
      db,
      `UPDATE assets SET maple_id = 'mid-1', deleted_reason = 'reaped',
         original_path = '/libraries/main/gone.dng' WHERE id = ?`,
      assetId,
    );

    const info = await findCoreInfoById(oid(assetId), testSqliteDb(db));
    expect(info!.id.toHexString()).toBe(assetId);
    expect(info!.folder_id?.toHexString()).toBe(libraryId);
    expect(info!.abs_path).toBe('/libraries/main/gone.dng');
    expect(info!.maple_id).toBe('mid-1');
    expect(info!.deleted_at).toBe('2026-04-05T00:00:00Z');
    expect(info!.deleted_reason).toBe('reaped');
    expect(info!.original_path).toBe('/libraries/main/gone.dng');
    expect(info!.description).toBe('caption');
    expect(info!.ocr_text).toBe('TEXT');
    expect(info!.exif).toEqual({ iso: 400 });
  });

  test('reports an empty maple_id as null', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const assetId = insertAsset(db);
    run(db, `UPDATE assets SET maple_id = '' WHERE id = ?`, assetId);
    const info = await findCoreInfoById(oid(assetId), testSqliteDb(db));
    expect(info!.maple_id).toBeNull();
  });
});

describe('findListItems', () => {
  test('returns live assets newest first, with seconds-resolution mtime', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { path: '/libraries/main' });
    const older = insertAsset(db, {
      exif: JSON.stringify({ captured_at: '2020-01-01T00:00:00Z' }),
    });
    const newer = insertAsset(db, {
      exif: JSON.stringify({ captured_at: '2026-01-01T00:00:00Z' }),
    });
    insertLocation(db, { assetId: older, libraryId, path: '', filename: 'old.dng' });
    insertLocation(db, { assetId: newer, libraryId, path: '', filename: 'new.dng' });
    run(db, `UPDATE assets SET mtime = 1700000000123`);

    const items = await findListItems({}, 10, testSqliteDb(db));
    expect(items.map((i) => i.id)).toEqual([newer, older]);
    expect(items[0]!.mtime).toBe(1_700_000_000);
    expect(items[0]!.filename).toBe('new.dng');
    expect(items[0]!.abs_path).toBe('/libraries/main/new.dng');
  });

  test('excludes soft-deleted assets unless liveOnly is explicitly false', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const sql = testSqliteDb(db);
    const libraryId = insertFolder(db);
    const live = insertAsset(db);
    const trashed = insertAsset(db, { deletedAt: '2026-04-01T00:00:00Z' });
    insertLocation(db, { assetId: live, libraryId, filename: 'live.dng' });
    insertLocation(db, { assetId: trashed, libraryId, filename: 'trashed.dng' });

    expect((await findListItems({}, 10, sql)).map((i) => i.id)).toEqual([live]);
    expect((await findListItems({ liveOnly: false }, 10, sql)).map((i) => i.id).sort()).toEqual(
      [live, trashed].sort(),
    );
  });

  test('applies the has_xmp, rating and captured_after residuals', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const sql = testSqliteDb(db);
    const libraryId = insertFolder(db);
    const keep = insertAsset(db, { exif: JSON.stringify({ captured_at: '2026-06-01T00:00:00Z' }) });
    const drop = insertAsset(db, { exif: JSON.stringify({ captured_at: '2020-06-01T00:00:00Z' }) });
    insertLocation(db, { assetId: keep, libraryId, filename: 'keep.dng' });
    insertLocation(db, { assetId: drop, libraryId, filename: 'drop.dng' });
    run(db, `UPDATE assets SET has_xmp = 1, rating = 5 WHERE id = ?`, keep);

    expect((await findListItems({ hasXmp: true }, 10, sql)).map((i) => i.id)).toEqual([keep]);
    expect((await findListItems({ ratingGte: 3 }, 10, sql)).map((i) => i.id)).toEqual([keep]);
    expect(
      (await findListItems({ capturedAfterIso: '2025-01-01T00:00:00Z' }, 10, sql)).map((i) => i.id),
    ).toEqual([keep]);
    expect((await findListItems({ hasXmp: false }, 10, sql)).map((i) => i.id)).toEqual([drop]);
  });

  test('clamps the limit, and treats a non-finite limit as the default', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const sql = testSqliteDb(db);
    const libraryId = insertFolder(db);
    for (let i = 0; i < 3; i += 1) {
      const assetId = insertAsset(db);
      insertLocation(db, { assetId, libraryId, filename: `a${i}.dng` });
    }
    expect(await findListItems({}, 2, sql)).toHaveLength(2);
    expect(await findListItems({}, Number.NaN, sql)).toHaveLength(3);
    expect(await findListItems({}, -5, sql)).toHaveLength(3);
  });

  test('returns only the columns the list DTO declares', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, filename: 'a.dng' });
    // The payloads a grid page must never drag along.
    insertDetail(db, assetId, {
      vision: JSON.stringify({ caption: 'x'.repeat(4000) }),
      transcript: JSON.stringify({
        text: 'y'.repeat(4000),
        language: 'en',
        model: 'whisper',
        duration_sec: 1,
        generated_at: '2026-01-01T00:00:00Z',
      }),
    });

    const [item] = await findListItems({}, 10, testSqliteDb(db));
    expect(Object.keys(item!).sort()).toEqual(
      [
        'abs_path',
        'fileinfo',
        'filename',
        'folder_id',
        'has_xmp',
        'hidden',
        'hidden_ack',
        'hidden_reason',
        'id',
        'mtime',
        'rating',
      ].sort(),
    );
    expect(JSON.stringify(item).length).toBeLessThan(1000);
  });
});

describe('backup-sidecar lookups', () => {
  test('resolves by maple_id when the asset has a live location in the library', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, filename: 'a.dng' });
    run(db, `UPDATE assets SET maple_id = 'content-1' WHERE id = ?`, assetId);

    const found = await findLiveAssetIdByMapleId('content-1', oid(libraryId), testSqliteDb(db));
    expect(found?.toHexString()).toBe(assetId);
  });

  test('misses when every location in that library is soft-deleted', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, {
      assetId,
      libraryId,
      filename: 'a.dng',
      deletedAt: '2026-04-01T00:00:00Z',
    });
    run(db, `UPDATE assets SET maple_id = 'content-1' WHERE id = ?`, assetId);

    expect(
      await findLiveAssetIdByMapleId('content-1', oid(libraryId), testSqliteDb(db)),
    ).toBeNull();
  });

  test('resolves by (device, phasset local id)', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId, filename: 'a.dng' });
    insertPhassetLink(db, { assetId, deviceId: 'device-a', phassetLocalId: 'local-1' });

    const found = await findLiveAssetIdByPhassetLink(
      'device-a',
      'local-1',
      oid(libraryId),
      testSqliteDb(db),
    );
    expect(found?.toHexString()).toBe(assetId);
  });

  test('is scoped to the library the sidecar is being written into', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryA = insertFolder(db, { path: '/libraries/a', slug: 'a' });
    const libraryB = insertFolder(db, { path: '/libraries/b', slug: 'b' });
    const assetId = insertAsset(db);
    insertLocation(db, { assetId, libraryId: libraryA, filename: 'a.dng' });
    insertPhassetLink(db, { assetId, deviceId: 'device-a', phassetLocalId: 'local-1' });

    expect(
      await findLiveAssetIdByPhassetLink('device-a', 'local-1', oid(libraryB), testSqliteDb(db)),
    ).toBeNull();
  });
});
