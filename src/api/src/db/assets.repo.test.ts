/**
 * Assets repo unit tests. Requires a running MongoDB; skip gracefully
 * if unreachable. Mirrors the pattern in `changes.repo.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  findCoreInfoById,
  findDetailById,
  findListItems,
  hardDelete,
  markSoftDeleted,
  parseAssetId,
  requeueEnrichmentStage,
  restoreFromTrash,
  setDescriptionOverride,
  setHasXmp,
  setPlaceOverride,
} from './assets.repo.ts';
import { closeDb } from './client.ts';
import { pendingEnrichment } from './schema.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_assets_repo_test_${process.pid}`;
const ORIGINAL_MONGO_DB = process.env.MAPLE_MONGO_DB;
const ORIGINAL_MONGO_URI = process.env.MAPLE_MONGO_URI;

let client: MongoClient | null = null;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

beforeEach(async () => {
  client = await tryConnect();
  if (!client) return;
  // Reset the API's module-cached MongoClient BEFORE changing the env
  // so any subsequent getDb() call re-resolves MAPLE_MONGO_DB to our
  // test DB rather than re-using a sibling test file's cached
  // connection. Mirrors changes.repo.test.ts.
  await closeDb();
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
  if (ORIGINAL_MONGO_DB === undefined) {
    delete process.env.MAPLE_MONGO_DB;
  } else {
    process.env.MAPLE_MONGO_DB = ORIGINAL_MONGO_DB;
  }
  if (ORIGINAL_MONGO_URI === undefined) {
    delete process.env.MAPLE_MONGO_URI;
  } else {
    process.env.MAPLE_MONGO_URI = ORIGINAL_MONGO_URI;
  }
  await closeDb();
});

async function seedAsset(d: Db, overrides: Record<string, unknown> = {}): Promise<ObjectId> {
  const folderId = (overrides.folder_id as ObjectId | undefined) ?? new ObjectId();
  const id = new ObjectId();
  // Build fileinfo[0] from the test overrides if they specify a filename;
  // otherwise default to "a.dng" at library root. Tests that need an
  // explicit fileinfo entry pass `fileinfo: [...]` directly.
  const filename = (overrides.filename as string | undefined) ?? 'a.dng';
  const fileinfo = (overrides.fileinfo as unknown) ?? [
    { path: '', filename, library_id: folderId, deleted_at: null },
  ];
  const stripped = { ...overrides };
  delete stripped.folder_id;
  delete stripped.filename;
  delete stripped.fileinfo;
  delete stripped.abs_path;
  await d.collection('assets').insertOne({
    _id: id,
    fileinfo,
    size: 1024,
    mtime: 1_700_000_000_000,
    rating: 3,
    flag: 0,
    color_label: '',
    indexed_at: '2026-01-01T00:00:00Z',
    has_xmp: false,
    deleted_at: null,
    enrichment: pendingEnrichment(),
    ...stripped,
  } as never);
  return id;
}

describe('assets.repo', () => {
  describe('parseAssetId', () => {
    it('returns ObjectId for valid hex', () => {
      const oid = parseAssetId('507f1f77bcf86cd799439011');
      expect(oid).not.toBeNull();
    });

    it('returns null for garbage', () => {
      expect(parseAssetId('not-an-objectid')).toBeNull();
      expect(parseAssetId('')).toBeNull();
    });
  });

  describe('findDetailById', () => {
    it('returns a fully-shaped DTO with id + folder_id as hex strings', async () => {
      if (!db) return;
      const id = await seedAsset(db, {
        description: 'a caption',
        ocr_text: 'some words',
        place: { source: 'nominatim', search_blob: 'x' },
      });
      const dto = await findDetailById(id, db);
      expect(dto).not.toBeNull();
      expect(dto!.id).toBe(id.toHexString());
      expect(typeof dto!.folder_id).toBe('string');
      // mtime stays in ms in the detail DTO (only the list endpoint
      // converts to seconds).
      expect(dto!.mtime).toBe(1_700_000_000_000);
      expect(dto!.description).toBe('a caption');
      expect(dto!.ocr_text).toBe('some words');
      // enrichment is always normalised (pending stages even when absent).
      expect(dto!.enrichment.geocode.done_at).toBeNull();
      expect(dto!.enrichment.face.done_at).toBeNull();
      expect(dto!.enrichment.describe.done_at).toBeNull();
    });

    it('passes through description_meta (not on AssetDoc) verbatim', async () => {
      if (!db) return;
      const meta = { provider: 'ollama', model: 'qwen3-vl:8b' };
      const id = await seedAsset(db, { description_meta: meta });
      const dto = await findDetailById(id, db);
      expect(dto!.description_meta).toEqual(meta);
    });

    it('returns null for a missing id', async () => {
      if (!db) return;
      const dto = await findDetailById(new ObjectId(), db);
      expect(dto).toBeNull();
    });
  });

  describe('findCoreInfoById', () => {
    it('returns ObjectIds (not strings) so route side-effect code can use them', async () => {
      if (!db) return;
      const id = await seedAsset(db, { maple_id: 'abc123' });
      const info = await findCoreInfoById(id, db);
      expect(info).not.toBeNull();
      expect(info!.id).toBeInstanceOf(ObjectId);
      expect(info!.folder_id).toBeInstanceOf(ObjectId);
      expect(info!.maple_id).toBe('abc123');
    });

    it('normalises a missing maple_id to null', async () => {
      if (!db) return;
      const id = await seedAsset(db);
      const info = await findCoreInfoById(id, db);
      expect(info!.maple_id).toBeNull();
    });

    it('returns null for a missing id', async () => {
      if (!db) return;
      const info = await findCoreInfoById(new ObjectId(), db);
      expect(info).toBeNull();
    });
  });

  describe('findListItems', () => {
    it('returns list-item DTOs with mtime in seconds', async () => {
      if (!db) return;
      // 2026-05-17 12:30 UTC, in ms.
      const mtimeMs = Date.UTC(2026, 4, 17, 12, 30, 0);
      await seedAsset(db, { mtime: mtimeMs });
      const rows = await findListItems({ liveOnly: true }, 100, db);
      expect(rows.length).toBe(1);
      expect(rows[0].mtime).toBe(Math.floor(mtimeMs / 1000));
    });

    it('excludes soft-deleted rows when liveOnly is true (default)', async () => {
      if (!db) return;
      await seedAsset(db, { filename: 'live.dng', deleted_at: null });
      await seedAsset(db, {
        filename: 'trashed.dng',
        deleted_at: '2026-01-01T00:00:00Z',
      });
      const rows = await findListItems({}, 100, db);
      expect(rows.length).toBe(1);
      expect(rows[0].filename).toBe('live.dng');
    });

    it('filters by has_xmp + rating + captured_after', async () => {
      if (!db) return;
      await seedAsset(db, {
        filename: 'a.dng',
        has_xmp: true,
        rating: 5,
        exif: { captured_at: '2026-06-01T00:00:00Z' },
      });
      await seedAsset(db, {
        filename: 'b.dng',
        has_xmp: false,
        rating: 0,
        exif: { captured_at: '2025-01-01T00:00:00Z' },
      });
      await seedAsset(db, {
        filename: 'c.dng',
        has_xmp: true,
        rating: 1,
        exif: { captured_at: '2024-01-01T00:00:00Z' },
      });
      const rows = await findListItems(
        {
          hasXmp: true,
          ratingGte: 1,
          capturedAfterIso: '2025-12-01T00:00:00Z',
        },
        100,
        db,
      );
      expect(rows.length).toBe(1);
      expect(rows[0].filename).toBe('a.dng');
    });

    it('normalizes invalid limits to the default (1000) before clamping', async () => {
      if (!db) return;
      // Seed 3 rows. Both NaN and < 1 limits are invalid; the repo
      // normalizes them to the default (1000) — *not* clamping NaN
      // through `Math.min(Math.max(NaN, 1), 20000)` which yields NaN
      // and turns the find into "no limit" (unbounded scan).
      for (let i = 0; i < 3; i++) {
        await seedAsset(db, { filename: `f${i}.dng` });
      }
      const rowsZero = await findListItems({}, 0, db);
      expect(rowsZero.length).toBe(3);
      const rowsNaN = await findListItems({}, Number.NaN, db);
      expect(rowsNaN.length).toBe(3);
    });

    it('clamps positive integer limits to the [1, 20000] upper bound', async () => {
      if (!db) return;
      for (let i = 0; i < 3; i++) {
        await seedAsset(db, { filename: `g${i}.dng` });
      }
      const rows = await findListItems({}, 2, db);
      expect(rows.length).toBe(2);
    });
  });

  describe('setHasXmp', () => {
    it('flips the has_xmp flag', async () => {
      if (!db) return;
      const id = await seedAsset(db, { has_xmp: false });
      await setHasXmp(id, true, db);
      const dto = await findDetailById(id, db);
      // has_xmp isn't part of the detail DTO but the raw doc should
      // reflect the write.
      const raw = await db.collection('assets').findOne({ _id: id });
      expect((raw as any).has_xmp).toBe(true);
      expect(dto).not.toBeNull();
    });
  });

  describe('setPlaceOverride / setDescriptionOverride', () => {
    it('sets place + recomputes search_blob atomically', async () => {
      if (!db) return;
      const id = await seedAsset(db);
      await setPlaceOverride(
        id,
        {
          source: 'nominatim',
          geocoder_version: 1,
          geocoded_at: '2026-01-01T00:00:00Z',
          lat: 0,
          lon: 0,
          display_name: null,
          address: {},
          pois: [],
          rollups: { locality: null, region: null, country_code: null },
          search_blob: 'paris',
        },
        db,
      );
      const dto = await findDetailById(id, db);
      expect(dto!.place?.search_blob).toBe('paris');
      // search_blob on the doc is the unified blob — should contain "paris".
      const raw = await db.collection('assets').findOne({ _id: id });
      expect((raw as any).search_blob).toContain('paris');
    });

    it('clears place when set to null', async () => {
      if (!db) return;
      const id = await seedAsset(db, {
        place: {
          source: 'nominatim',
          search_blob: 'x',
          rollups: {},
          address: {},
          pois: [],
        },
      });
      await setPlaceOverride(id, null, db);
      const dto = await findDetailById(id, db);
      expect(dto!.place).toBeNull();
    });

    it('sets description override', async () => {
      if (!db) return;
      const id = await seedAsset(db);
      await setDescriptionOverride(id, 'manual caption', db);
      const dto = await findDetailById(id, db);
      expect(dto!.description).toBe('manual caption');
    });
  });

  describe('requeueEnrichmentStage', () => {
    it('bumps version + clears claim fields', async () => {
      if (!db) return;
      const id = await seedAsset(db, {
        enrichment: {
          geocode: {
            done_at: '2026-01-01T00:00:00Z',
            locked_by: 'worker-1',
            lease_expires_at: '2026-01-01T01:00:00Z',
            attempts: 3,
            last_error: 'boom',
            version: 7,
            dead_letter_at: '2026-01-01T02:00:00Z',
          },
          face: pendingEnrichment().face,
          describe: pendingEnrichment().describe,
        },
      });
      const result = await requeueEnrichmentStage(id, 'geocode', db);
      expect(result?.version).toBe(8);
      const dto = await findDetailById(id, db);
      expect(dto!.enrichment.geocode.done_at).toBeNull();
      expect(dto!.enrichment.geocode.attempts).toBe(0);
      expect(dto!.enrichment.geocode.last_error).toBeNull();
      expect(dto!.enrichment.geocode.locked_by).toBeNull();
      expect(dto!.enrichment.geocode.dead_letter_at).toBeNull();
      expect(dto!.enrichment.geocode.version).toBe(8);
    });

    it('returns null for an unknown asset', async () => {
      if (!db) return;
      const result = await requeueEnrichmentStage(new ObjectId(), 'geocode', db);
      expect(result).toBeNull();
    });

    it('starts version at 1 when current is null/0', async () => {
      if (!db) return;
      const id = await seedAsset(db);
      const result = await requeueEnrichmentStage(id, 'describe', db);
      expect(result?.version).toBe(1);
    });
  });

  describe('markSoftDeleted / hardDelete / restoreFromTrash', () => {
    it('markSoftDeleted records deleted_at + original_path', async () => {
      if (!db) return;
      // Seed the library row + the asset, so findCoreInfoById can resolve
      // the library root and compose abs_path from fileinfo[0].
      const libraryId = new ObjectId();
      await db.collection('folders').insertOne({
        _id: libraryId,
        path: '/lib',
        label: 'lib',
        last_scan: null,
        file_count: 0,
        created_at: '2026-01-01T00:00:00Z',
      } as never);
      const id = await seedAsset(db, { folder_id: libraryId });
      await markSoftDeleted({
        id,
        libraryRoot: '/lib',
        libraryId,
        newAbsPath: '/lib/.maple/trash/a.dng',
        originalAbsPath: '/lib/a.dng',
        dbOverride: db,
      });
      const info = await findCoreInfoById(id, db);
      expect(info!.abs_path).toBe('/lib/.maple/trash/a.dng');
      expect(info!.deleted_at).not.toBeNull();
      expect(info!.original_path).toBe('/lib/a.dng');
    });

    it('hardDelete removes the row', async () => {
      if (!db) return;
      const id = await seedAsset(db);
      await hardDelete(id, db);
      const info = await findCoreInfoById(id, db);
      expect(info).toBeNull();
    });

    it('restoreFromTrash deletes watcher-inserted transient rows at the new path', async () => {
      if (!db) return;
      const libraryId = new ObjectId();
      await db.collection('folders').insertOne({
        _id: libraryId,
        path: '/lib',
        label: 'lib',
        last_scan: null,
        file_count: 0,
        created_at: '2026-01-01T00:00:00Z',
      } as never);
      // Asset in trash.
      const id = await seedAsset(db, {
        folder_id: libraryId,
        fileinfo: [
          { path: '.maple/trash', filename: 'a.dng', library_id: libraryId, deleted_at: null },
        ],
        deleted_at: '2026-01-01T00:00:00Z',
        original_path: '/lib/a.dng',
      });
      // Watcher-inserted transient row at the restore target.
      await db.collection('assets').insertOne({
        _id: new ObjectId(),
        fileinfo: [{ path: '', filename: 'a.dng', library_id: libraryId, deleted_at: null }],
        size: 1,
        mtime: 1,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: 'x',
        deleted_at: null,
      } as never);
      const restoredMtimeMs = Date.UTC(2026, 5, 1, 0, 0, 0);
      await restoreFromTrash({
        id,
        libraryRoot: '/lib',
        libraryId,
        newAbsPath: '/lib/a.dng',
        size: 2048,
        mtimeMs: restoredMtimeMs,
        dbOverride: db,
      });
      // Only one row should now sit at /lib/a.dng — ours.
      const rows = await db
        .collection('assets')
        .find({
          fileinfo: {
            $elemMatch: { library_id: libraryId, path: '', filename: 'a.dng' },
          },
        } as never)
        .toArray();
      expect(rows.length).toBe(1);
      expect(rows[0]!._id.toHexString()).toBe(id.toHexString());
      const info = await findCoreInfoById(id, db);
      expect(info!.deleted_at).toBeNull();
      expect(info!.original_path).toBeNull();
      // Regression for #166: mtime must be a number (epoch-ms), not an
      // ISO string. The assets-list serialiser does `Math.floor(r.mtime
      // / 1000)`; a string would yield NaN.
      expect(typeof (rows[0] as unknown as { mtime: unknown }).mtime).toBe('number');
      expect((rows[0] as unknown as { mtime: number }).mtime).toBe(restoredMtimeMs);
    });
  });
});
