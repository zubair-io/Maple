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
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { withTestDb } from './test-db.test-helpers.ts';

const TEST_DB = withTestDb(`maple_test_migrations_backfills_${process.pid}`);
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

  it('repair pass fixes rows whose numeric year/month is NULL or only partially set', async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureIndexes } = await import('./client.ts');
    await closeDb();

    const lib = new ObjectId();
    const base = {
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-05-11T00:00:00Z',
    };
    // The original backfill only targets `captured_year: {$exists:false}`. The
    // repair must ALSO close: (a) rows whose numeric fields are present-but-NULL
    // (a prior failed/stalled run), and (b) rows where only ONE of year/month
    // is set — both diverge from the grid's captured_at range. Modern `fileinfo`
    // shape so the unrelated fileinfo backfill leaves these rows alone.
    await db!.collection('assets').insertMany([
      {
        ...base,
        maple_id: 'bothnull',
        fileinfo: [{ library_id: lib, path: '', filename: 'a.jpg', deleted_at: null }],
        exif: {
          captured_at: '2024-03-09T10:00:00.000Z',
          captured_year: null,
          captured_month: null,
        },
      },
      {
        ...base,
        maple_id: 'monthnull',
        fileinfo: [{ library_id: lib, path: '', filename: 'b.jpg', deleted_at: null }],
        exif: {
          captured_at: '2024-07-20T10:00:00.000Z',
          captured_year: 2024,
          captured_month: null,
        },
      },
    ] as never);

    await ensureIndexes();

    const exifOf = async (id: string) =>
      (await db!.collection('assets').findOne({ maple_id: id }))?.exif as
        | { captured_year?: number; captured_month?: number }
        | undefined;
    // both-null → both derived (UTC) so buckets see it and match the grid range.
    expect((await exifOf('bothnull'))?.captured_year).toBe(2024);
    expect((await exifOf('bothnull'))?.captured_month).toBe(3);
    // asymmetric (year set, month null) → the broadened `$or` filter catches it.
    expect((await exifOf('monthnull'))?.captured_month).toBe(7);

    const { migrationApplied } = await import('./migrations.ts');
    expect(await migrationApplied(db!, 'repair-captured-year-month-2026-06-07')).toBe(true);
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
        (after!.fileinfo![0].library_id as { equals: (o: unknown) => boolean }).equals(folderId),
      ).toBe(true);
    });

    it('skips rows that already have fileinfo populated', async () => {
      if (!mongoReachable) return;
      const { closeDb, ensureIndexes } = await import('./client.ts');
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

  describe('drop-legacy-location-fields cleanup', () => {
    it('$unsets the retired location + cache fields on a fileinfo-bearing row', async () => {
      if (!mongoReachable) return;
      const { closeDb, ensureIndexes } = await import('./client.ts');
      await closeDb();

      const folderId = new ObjectId();
      const assetId = new ObjectId();
      await db!.collection('assets').insertOne({
        _id: assetId,
        // Already migrated: carries fileinfo[] AND the dead legacy fields.
        fileinfo: [{ path: 'vacation', filename: 'IMG.dng', library_id: folderId }],
        folder_id: folderId,
        filename: 'IMG.dng',
        abs_path: '/lib/vacation/IMG.dng',
        thumb_path: '/lib/vacation/.maple/thumbs/abc.jpg',
        preview_path: '/lib/vacation/.maple/previews/abc_1280.jpg',
        size: 1,
        mtime: 1,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: '2026-06-11T00:00:00Z',
      });

      await ensureIndexes();

      const after = (await db!.collection('assets').findOne({ _id: assetId })) as Record<
        string,
        unknown
      > | null;
      expect(after).not.toBeNull();
      // The five retired fields are gone.
      expect('abs_path' in after!).toBe(false);
      expect('folder_id' in after!).toBe(false);
      expect('filename' in after!).toBe(false);
      expect('thumb_path' in after!).toBe(false);
      expect('preview_path' in after!).toBe(false);
      // fileinfo (the source of truth) is untouched.
      expect((after!.fileinfo as unknown[]).length).toBe(1);
    });

    it('leaves a row that has no fileinfo untouched (location still rebuildable)', async () => {
      if (!mongoReachable) return;
      const { closeDb, ensureIndexes } = await import('./client.ts');
      await closeDb();

      // folder_id points at an UNREGISTERED folder, so the fileinfo backfill
      // can't resolve a library root and skips the row — it stays fileinfo-less.
      // The cleanup must then leave its legacy fields intact, because they are
      // the only source its location could be rebuilt from.
      const assetId = new ObjectId();
      await db!.collection('assets').insertOne({
        _id: assetId,
        folder_id: new ObjectId(),
        filename: 'orphan.dng',
        abs_path: '/gone/orphan.dng',
        thumb_path: '/gone/.maple/thumbs/x.jpg',
        size: 1,
        mtime: 1,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: '2026-06-11T00:00:00Z',
      });

      await ensureIndexes();

      const after = (await db!.collection('assets').findOne({ _id: assetId })) as Record<
        string,
        unknown
      > | null;
      expect(after?.fileinfo).toBeUndefined();
      expect(after?.abs_path).toBe('/gone/orphan.dng');
      expect(after?.thumb_path).toBe('/gone/.maple/thumbs/x.jpg');
    });

    it('leaves a row with a degenerate empty fileinfo[] untouched', async () => {
      if (!mongoReachable) return;
      const { closeDb, ensureIndexes } = await import('./client.ts');
      await closeDb();

      // An empty `fileinfo: []` has no primary entry to resolve a location
      // from, so the cleanup must NOT strip the legacy fields (matching the
      // no-fileinfo case) — `fileinfo.0` does not exist, so the row is skipped.
      const assetId = new ObjectId();
      await db!.collection('assets').insertOne({
        _id: assetId,
        fileinfo: [],
        abs_path: '/lib/empty.dng',
        thumb_path: '/lib/.maple/thumbs/e.jpg',
        size: 1,
        mtime: 1,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: '2026-06-11T00:00:00Z',
      });

      await ensureIndexes();

      const after = (await db!.collection('assets').findOne({ _id: assetId })) as Record<
        string,
        unknown
      > | null;
      expect(after?.abs_path).toBe('/lib/empty.dng');
      expect(after?.thumb_path).toBe('/lib/.maple/thumbs/e.jpg');
    });

    it('is gated by the migrations sentinel (second boot skips)', async () => {
      if (!mongoReachable) return;
      const { closeDb, ensureIndexes } = await import('./client.ts');
      const { migrationApplied } = await import('./migrations.ts');
      await closeDb();

      await ensureIndexes();
      expect(await migrationApplied(db!, 'drop-legacy-location-fields-2026-06-11')).toBe(true);

      // Insert a dirty (fileinfo + legacy fields) row AFTER the migration ran.
      // The sentinel must short-circuit the second boot, leaving it dirty.
      const folderId = new ObjectId();
      const assetId = new ObjectId();
      await db!.collection('assets').insertOne({
        _id: assetId,
        fileinfo: [{ path: '', filename: 'late.dng', library_id: folderId }],
        abs_path: '/lib/late.dng',
        size: 1,
        mtime: 1,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: '2026-06-11T00:00:00Z',
      });

      await ensureIndexes();

      const after = (await db!.collection('assets').findOne({ _id: assetId })) as Record<
        string,
        unknown
      > | null;
      expect(after?.abs_path).toBe('/lib/late.dng');
    });
  });
});
