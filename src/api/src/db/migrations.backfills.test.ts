/**
 * ensureIndexes backfill-gating tests. Verify the three backfill
 * updateMany calls (captured-year/month, place-search-blob,
 * asset-search-blob) and the fileinfo backfill do NOT re-run on a
 * second boot — proves the migrations sentinel stops the per-boot
 * scan damage that the original code path was causing.
 *
 * Skip-passes when Mongo is unreachable (same pattern as client.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';

const TEST_DB = `maple_test_migrations_backfills_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[migrations.backfills.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  for (const name of ['users', 'credentials', 'invites', 'refresh_tokens', 'challenges']) {
    await db.createCollection(name).catch(() => undefined);
  }
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('assets').deleteMany({});
  await db!.collection('migrations').deleteMany({});
  await db!.collection('folders').deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('./client.ts');
  await closeDb();
});

describe("ensureIndexes — backfills don't re-run on second boot", () => {
  it('second ensureIndexes() does NOT modify the backfill-target row again', async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureIndexes } = await import('./client.ts');
    await closeDb();

    // Insert a row that the captured_year/month backfill would target:
    // has exif.captured_at, missing exif.captured_year.
    await db!.collection('assets').insertOne({
      folder_id: 'f',
      filename: 'x.jpg',
      abs_path: '/x.jpg',
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-05-11T00:00:00Z',
      exif: { captured_at: '2024-01-15T10:00:00Z' },
    });

    await ensureIndexes();
    const afterFirst = await db!.collection('assets').findOne({ filename: 'x.jpg' });
    expect((afterFirst as { exif?: { captured_year?: number } } | null)?.exif?.captured_year).toBe(
      2024,
    );

    // Sentinel should now be present.
    const { migrationApplied } = await import('./migrations.ts');
    expect(await migrationApplied(db!, 'exif-captured-year-month-backfill')).toBe(true);

    // Stomp the captured_year field. If the gate is broken, the second
    // ensureIndexes() call will re-run the backfill and restore it.
    // If the gate works, the value stays null.
    await db!
      .collection('assets')
      .updateOne(
        { filename: 'x.jpg' },
        { $unset: { 'exif.captured_year': '', 'exif.captured_month': '' } },
      );

    await ensureIndexes();
    const afterSecond = await db!.collection('assets').findOne({ filename: 'x.jpg' });
    // Gate worked: backfill was skipped, captured_year is still missing.
    expect(
      (afterSecond as { exif?: { captured_year?: number } } | null)?.exif?.captured_year,
    ).toBeUndefined();
  });

  it('place-search-blob backfill is gated by the migrations sentinel', async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureIndexes } = await import('./client.ts');
    await closeDb();

    // First boot — no rows, sentinel gets written for a zero-row run.
    await ensureIndexes();
    const { migrationApplied } = await import('./migrations.ts');
    expect(await migrationApplied(db!, 'place-search-blob-backfill')).toBe(true);

    // Insert a row that WOULD be matched by the backfill predicate. If
    // the gate is broken, the second ensureIndexes() will populate the
    // search_blob. If the gate works, the search_blob stays empty.
    await db!.collection('assets').insertOne({
      folder_id: 'f',
      filename: 'y.jpg',
      abs_path: '/y.jpg',
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-05-11T00:00:00Z',
      place: {
        search_blob: '',
        address: { city: 'Tokyo', country: 'Japan' },
      },
    });

    await ensureIndexes();
    const after = await db!.collection('assets').findOne({ filename: 'y.jpg' });
    expect((after as { place: { search_blob: string } } | null)?.place.search_blob).toBe('');
  });

  it('asset-search-blob backfill is gated by the migrations sentinel', async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureIndexes } = await import('./client.ts');
    await closeDb();

    await ensureIndexes();
    const { migrationApplied } = await import('./migrations.ts');
    expect(await migrationApplied(db!, 'asset-search-blob-backfill')).toBe(true);

    // Row that would be matched by the unified-blob predicate:
    // place.search_blob set, no top-level search_blob.
    await db!.collection('assets').insertOne({
      folder_id: 'f',
      filename: 'z.jpg',
      abs_path: '/z.jpg',
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-05-11T00:00:00Z',
      place: { search_blob: 'tokyo japan' },
    });

    await ensureIndexes();
    const after = await db!.collection('assets').findOne({ filename: 'z.jpg' });
    expect((after as { search_blob?: string } | null)?.search_blob).toBeUndefined();
  });

  describe('fileinfo backfill', () => {
    it('populates fileinfo[0] from abs_path/folder_id/filename for legacy rows', async () => {
      if (!mongoReachable) return;
      const { closeDb, ensureIndexes } = await import('./client.ts');
      const { ObjectId } = await import('mongodb');
      await closeDb();

      const folderId = new ObjectId();
      await db!.collection('folders').insertOne({
        _id: folderId,
        path: '/lib',
        label: 'x',
        last_scan: null,
        file_count: 0,
        created_at: '2026-05-20T00:00:00Z',
      });
      const assetId = new ObjectId();
      await db!.collection('assets').insertOne({
        _id: assetId,
        folder_id: folderId,
        filename: 'IMG_001.dng',
        abs_path: '/lib/vacation/2024/IMG_001.dng',
        size: 1,
        mtime: 1,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: '2026-05-20T00:00:00Z',
      });

      await ensureIndexes();

      const after = await db!.collection('assets').findOne({ _id: assetId });
      expect(after?.fileinfo).toHaveLength(1);
      expect(after?.fileinfo?.[0].path).toBe('vacation/2024');
      expect(after?.fileinfo?.[0].filename).toBe('IMG_001.dng');
      expect(
        (after?.fileinfo?.[0].library_id as { equals: (o: unknown) => boolean }).equals(folderId),
      ).toBe(true);
    });

    it('skips rows that already have fileinfo populated', async () => {
      if (!mongoReachable) return;
      const { closeDb, ensureIndexes } = await import('./client.ts');
      const { ObjectId } = await import('mongodb');
      await closeDb();

      const folderId = new ObjectId();
      await db!.collection('folders').insertOne({
        _id: folderId,
        path: '/lib',
        label: 'x',
        last_scan: null,
        file_count: 0,
        created_at: '2026-05-20T00:00:00Z',
      });
      const assetId = new ObjectId();
      const preset = [{ path: 'preset', filename: 'IMG.dng', library_id: folderId }];
      await db!.collection('assets').insertOne({
        _id: assetId,
        folder_id: folderId,
        filename: 'IMG.dng',
        abs_path: '/lib/other/IMG.dng',
        fileinfo: preset,
        size: 1,
        mtime: 1,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: '2026-05-20T00:00:00Z',
      });

      await ensureIndexes();

      const after = await db!.collection('assets').findOne({ _id: assetId });
      expect(after?.fileinfo?.[0].path).toBe('preset');
    });

    it("handles files at the library root (path='')", async () => {
      if (!mongoReachable) return;
      const { closeDb, ensureIndexes } = await import('./client.ts');
      const { ObjectId } = await import('mongodb');
      await closeDb();

      const folderId = new ObjectId();
      await db!.collection('folders').insertOne({
        _id: folderId,
        path: '/lib',
        label: 'x',
        last_scan: null,
        file_count: 0,
        created_at: '2026-05-20T00:00:00Z',
      });
      const assetId = new ObjectId();
      await db!.collection('assets').insertOne({
        _id: assetId,
        folder_id: folderId,
        filename: 'root.dng',
        abs_path: '/lib/root.dng',
        size: 1,
        mtime: 1,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: '2026-05-20T00:00:00Z',
      });

      await ensureIndexes();

      const after = await db!.collection('assets').findOne({ _id: assetId });
      expect(after?.fileinfo?.[0].path).toBe('');
      expect(after?.fileinfo?.[0].filename).toBe('root.dng');
    });

    it('is gated by the migrations sentinel (second boot skips)', async () => {
      if (!mongoReachable) return;
      const { closeDb, ensureIndexes } = await import('./client.ts');
      const { migrationApplied } = await import('./migrations.ts');
      const { ObjectId } = await import('mongodb');
      await closeDb();

      await ensureIndexes();
      expect(await migrationApplied(db!, 'fileinfo-backfill-2026-05-20')).toBe(true);

      // Insert a legacy row AFTER the migration ran — it must stay unmigrated
      // because the sentinel short-circuits the second boot.
      const folderId = new ObjectId();
      await db!.collection('folders').insertOne({
        _id: folderId,
        path: '/lib',
        label: 'x',
        last_scan: null,
        file_count: 0,
        created_at: '2026-05-20T00:00:00Z',
      });
      const assetId = new ObjectId();
      await db!.collection('assets').insertOne({
        _id: assetId,
        folder_id: folderId,
        filename: 'late.dng',
        abs_path: '/lib/late.dng',
        size: 1,
        mtime: 1,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: '2026-05-20T00:00:00Z',
      });

      await ensureIndexes();

      const after = await db!.collection('assets').findOne({ _id: assetId });
      expect(after?.fileinfo).toBeUndefined();
    });
  });
});
