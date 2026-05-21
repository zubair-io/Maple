/**
 * Migration-gate tests. Verify:
 *   - `recordMigration` writes a sentinel doc; `migrationApplied` reads it.
 *   - Duplicate `recordMigration` calls don't throw (E11000 swallowed).
 *   - `ensureIndexes` run twice does NOT re-execute the three backfill
 *     updateMany calls on the second boot — proves the gate stops the
 *     per-boot scan damage that the original code path was causing.
 *
 * Skip-passes when Mongo is unreachable (same pattern as client.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';

const TEST_DB = `maple_test_migrations_${process.pid}`;
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
    console.log('[migrations.test] skipping: MongoDB unreachable');
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

describe('migrations module', () => {
  it('migrationApplied → false before recordMigration; true after', async () => {
    if (!mongoReachable) return;
    const { closeDb } = await import('./client.ts');
    await closeDb();
    const { migrationApplied, recordMigration } = await import('./migrations.ts');
    expect(await migrationApplied(db!, 'exif-captured-year-month-backfill')).toBe(false);
    await recordMigration(db!, 'exif-captured-year-month-backfill', 42);
    expect(await migrationApplied(db!, 'exif-captured-year-month-backfill')).toBe(true);
    // Stores rows + applied_at.
    const doc = await db!.collection('migrations').findOne({
      _id: 'exif-captured-year-month-backfill',
    } as Parameters<ReturnType<typeof db.collection>['findOne']>[0]);
    expect(doc).toBeDefined();
    expect((doc as { rows: number }).rows).toBe(42);
    expect((doc as { applied_at: Date }).applied_at).toBeInstanceOf(Date);
  });

  it("recordMigration is idempotent — duplicate calls don't throw", async () => {
    if (!mongoReachable) return;
    const { closeDb } = await import('./client.ts');
    await closeDb();
    const { recordMigration, migrationApplied } = await import('./migrations.ts');
    await recordMigration(db!, 'place-search-blob-backfill', 10);
    // Second call must not throw (E11000 duplicate key is swallowed —
    // it just means another boot got there first).
    await recordMigration(db!, 'place-search-blob-backfill', 99);
    expect(await migrationApplied(db!, 'place-search-blob-backfill')).toBe(true);
    // First write wins; second is a no-op.
    const doc = await db!.collection('migrations').findOne({
      _id: 'place-search-blob-backfill',
    } as Parameters<ReturnType<typeof db.collection>['findOne']>[0]);
    expect((doc as { rows: number }).rows).toBe(10);
  });
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

  describe('mergeDuplicateAssets', () => {
    // The unique partial index on maple_id forbids same-maple_id rows in the
    // steady state. Tests for the heal migration MUST drop the index in
    // setup so the dup-state can be manufactured; ensureIndexes then
    // re-creates the index on the merged (clean) state.
    async function dropMapleIdIndex(): Promise<void> {
      try {
        await db!.collection('assets').dropIndex('maple_id_1');
      } catch {
        // IndexNotFound — fine, fresh DB.
      }
    }

    it('collapses rows sharing a maple_id into one with union fileinfo[]', async () => {
      if (!mongoReachable) return;
      const { mergeDuplicateAssets } = await import('./migrations.ts');
      const { ObjectId } = await import('mongodb');
      await dropMapleIdIndex();

      const lib = new ObjectId();
      const sharedId = 'a'.repeat(32);

      await db!.collection('assets').insertMany([
        {
          _id: new ObjectId(),
          folder_id: lib,
          filename: 'x.dng',
          abs_path: '/lib/a/x.dng',
          fileinfo: [{ path: 'a', filename: 'x.dng', library_id: lib }],
          maple_id: sharedId,
          size: 1,
          mtime: 1,
          rating: 5,
          flag: 1,
          color_label: 'red',
          indexed_at: '2026-05-01T00:00:00Z',
        },
        {
          _id: new ObjectId(),
          folder_id: lib,
          filename: 'x.dng',
          abs_path: '/lib/b/x.dng',
          fileinfo: [{ path: 'b', filename: 'x.dng', library_id: lib }],
          maple_id: sharedId,
          size: 1,
          mtime: 1,
          rating: 0,
          flag: 0,
          color_label: '',
          indexed_at: '2026-05-10T00:00:00Z',
        },
      ] as never);

      const result = await mergeDuplicateAssets(db!);
      expect(result.merged_groups).toBe(1);
      expect(result.deleted_rows).toBe(1);

      const rows = await db!.collection('assets').find({ maple_id: sharedId }).toArray();
      expect(rows).toHaveLength(1);
      // Survivor is the earliest indexed_at — keeps its user-edited fields.
      expect(rows[0]!.rating).toBe(5);
      expect(rows[0]!.flag).toBe(1);
      expect(rows[0]!.color_label).toBe('red');
      // fileinfo[] is the union, de-duped by (lib, path, filename).
      expect(rows[0]!.fileinfo).toHaveLength(2);
      const sorted = (rows[0]!.fileinfo ?? []).map((e: any) => e.path).sort();
      expect(sorted).toEqual(['a', 'b']);
    });

    it('idempotent — does not touch already-unique rows', async () => {
      if (!mongoReachable) return;
      const { mergeDuplicateAssets } = await import('./migrations.ts');
      const { ObjectId } = await import('mongodb');
      await dropMapleIdIndex();

      const lib = new ObjectId();
      await db!.collection('assets').insertOne({
        _id: new ObjectId(),
        folder_id: lib,
        filename: 'solo.dng',
        abs_path: '/lib/solo.dng',
        fileinfo: [{ path: '', filename: 'solo.dng', library_id: lib }],
        maple_id: 'b'.repeat(32),
        size: 1,
        mtime: 1,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: '2026-05-01T00:00:00Z',
      } as never);

      const r1 = await mergeDuplicateAssets(db!);
      expect(r1.merged_groups).toBe(0);
      const r2 = await mergeDuplicateAssets(db!);
      expect(r2.merged_groups).toBe(0);
    });

    it('preserves survivor _id (no reinsert; just $set fileinfo)', async () => {
      if (!mongoReachable) return;
      const { mergeDuplicateAssets } = await import('./migrations.ts');
      const { ObjectId } = await import('mongodb');
      await dropMapleIdIndex();

      const lib = new ObjectId();
      const survivorId = new ObjectId();
      const loserId = new ObjectId();
      const sharedId = 'c'.repeat(32);

      await db!.collection('assets').insertMany([
        {
          _id: survivorId,
          folder_id: lib,
          filename: 'y.dng',
          abs_path: '/lib/A/y.dng',
          fileinfo: [{ path: 'A', filename: 'y.dng', library_id: lib }],
          maple_id: sharedId,
          size: 1,
          mtime: 1,
          rating: 3,
          flag: 0,
          color_label: '',
          indexed_at: '2026-05-01T00:00:00Z',
        },
        {
          _id: loserId,
          folder_id: lib,
          filename: 'y.dng',
          abs_path: '/lib/B/y.dng',
          fileinfo: [{ path: 'B', filename: 'y.dng', library_id: lib }],
          maple_id: sharedId,
          size: 1,
          mtime: 1,
          rating: 0,
          flag: 0,
          color_label: '',
          indexed_at: '2026-05-09T00:00:00Z',
        },
      ] as never);

      await mergeDuplicateAssets(db!);
      const survivor = await db!.collection('assets').findOne({ _id: survivorId });
      expect(survivor).not.toBeNull();
      const loser = await db!.collection('assets').findOne({ _id: loserId });
      expect(loser).toBeNull();
    });

    it('handles 3+ rows in a group', async () => {
      if (!mongoReachable) return;
      const { mergeDuplicateAssets } = await import('./migrations.ts');
      const { ObjectId } = await import('mongodb');
      await dropMapleIdIndex();

      const lib = new ObjectId();
      const sharedId = 'e'.repeat(32);
      const rows = ['a', 'b', 'c', 'd'].map((p, i) => ({
        _id: new ObjectId(),
        folder_id: lib,
        filename: 'z.dng',
        abs_path: `/lib/${p}/z.dng`,
        fileinfo: [{ path: p, filename: 'z.dng', library_id: lib }],
        maple_id: sharedId,
        size: 1,
        mtime: 1,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: `2026-05-0${1 + i}T00:00:00Z`,
      }));
      await db!.collection('assets').insertMany(rows as never[]);

      const result = await mergeDuplicateAssets(db!);
      expect(result.merged_groups).toBe(1);
      expect(result.deleted_rows).toBe(3);

      const survivors = await db!.collection('assets').find({ maple_id: sharedId }).toArray();
      expect(survivors).toHaveLength(1);
      expect(survivors[0]!.fileinfo).toHaveLength(4);
    });

    it('deduplicates fileinfo entries within the union', async () => {
      if (!mongoReachable) return;
      const { mergeDuplicateAssets } = await import('./migrations.ts');
      const { ObjectId } = await import('mongodb');
      await dropMapleIdIndex();

      const lib = new ObjectId();
      const sharedId = 'f'.repeat(32);
      const sameEntry = { path: 'shared', filename: 's.dng', library_id: lib };
      await db!.collection('assets').insertMany([
        {
          _id: new ObjectId(),
          folder_id: lib,
          filename: 's.dng',
          abs_path: '/lib/shared/s.dng',
          fileinfo: [sameEntry, { path: 'a', filename: 's.dng', library_id: lib }],
          maple_id: sharedId,
          size: 1,
          mtime: 1,
          rating: 0,
          flag: 0,
          color_label: '',
          indexed_at: '2026-05-01T00:00:00Z',
        },
        {
          _id: new ObjectId(),
          folder_id: lib,
          filename: 's.dng',
          abs_path: '/lib/shared/s.dng',
          fileinfo: [sameEntry, { path: 'b', filename: 's.dng', library_id: lib }],
          maple_id: sharedId,
          size: 1,
          mtime: 1,
          rating: 0,
          flag: 0,
          color_label: '',
          indexed_at: '2026-05-02T00:00:00Z',
        },
      ] as never);

      await mergeDuplicateAssets(db!);
      const merged = await db!.collection('assets').findOne({ maple_id: sharedId });
      // sameEntry appears in both → counts once. plus 'a' and 'b' → 3 total.
      expect(merged!.fileinfo).toHaveLength(3);
    });

    it("de-dup key tolerates '|' inside path/filename (JSON-encoded key)", async () => {
      if (!mongoReachable) return;
      const { mergeDuplicateAssets } = await import('./migrations.ts');
      const { ObjectId } = await import('mongodb');
      await dropMapleIdIndex();

      const lib = new ObjectId();
      const sharedId = '7'.repeat(32);
      // Two distinct (path, filename) pairs that would collide under a naive
      // `${path}|${filename}` key: 'a|b' + 'c' vs 'a' + 'b|c'. The JSON-encoded
      // key keeps them separate, so the union must contain both entries.
      await db!.collection('assets').insertMany([
        {
          _id: new ObjectId(),
          folder_id: lib,
          filename: 'c',
          abs_path: '/lib/a|b/c',
          fileinfo: [{ path: 'a|b', filename: 'c', library_id: lib }],
          maple_id: sharedId,
          size: 1,
          mtime: 1,
          rating: 0,
          flag: 0,
          color_label: '',
          indexed_at: '2026-05-01T00:00:00Z',
        },
        {
          _id: new ObjectId(),
          folder_id: lib,
          filename: 'b|c',
          abs_path: '/lib/a/b|c',
          fileinfo: [{ path: 'a', filename: 'b|c', library_id: lib }],
          maple_id: sharedId,
          size: 1,
          mtime: 1,
          rating: 0,
          flag: 0,
          color_label: '',
          indexed_at: '2026-05-02T00:00:00Z',
        },
      ] as never);

      await mergeDuplicateAssets(db!);
      const survivor = await db!.collection('assets').findOne({ maple_id: sharedId });
      expect(survivor).not.toBeNull();
      expect(survivor!.fileinfo).toHaveLength(2);
      const pairs = (survivor!.fileinfo ?? [])
        .map((e: { path: string; filename: string }) => `${e.path}::${e.filename}`)
        .sort();
      expect(pairs).toEqual(['a::b|c', 'a|b::c']);
    });

    it('de-dup prefers live entry over tombstoned for same (lib, path, filename)', async () => {
      if (!mongoReachable) return;
      const { mergeDuplicateAssets } = await import('./migrations.ts');
      const { ObjectId } = await import('mongodb');
      await dropMapleIdIndex();

      const lib = new ObjectId();
      const sharedId = '8'.repeat(32);
      // Same (lib, path, filename) across two rows: one tombstoned, the other
      // live. The merged union must keep the live entry, not the tombstone.
      await db!.collection('assets').insertMany([
        {
          _id: new ObjectId(),
          folder_id: lib,
          filename: 'q.dng',
          abs_path: '/lib/here/q.dng',
          fileinfo: [
            {
              path: 'here',
              filename: 'q.dng',
              library_id: lib,
              deleted_at: '2026-05-01T00:00:00Z',
            },
          ],
          maple_id: sharedId,
          size: 1,
          mtime: 1,
          rating: 0,
          flag: 0,
          color_label: '',
          indexed_at: '2026-05-01T00:00:00Z',
        },
        {
          _id: new ObjectId(),
          folder_id: lib,
          filename: 'q.dng',
          abs_path: '/lib/here/q.dng',
          fileinfo: [{ path: 'here', filename: 'q.dng', library_id: lib, deleted_at: null }],
          maple_id: sharedId,
          size: 1,
          mtime: 1,
          rating: 0,
          flag: 0,
          color_label: '',
          indexed_at: '2026-05-02T00:00:00Z',
        },
      ] as never);

      await mergeDuplicateAssets(db!);
      const survivor = await db!.collection('assets').findOne({ maple_id: sharedId });
      expect(survivor).not.toBeNull();
      expect(survivor!.fileinfo).toHaveLength(1);
      const entry = (survivor!.fileinfo as Array<{ deleted_at?: string | null }>)[0]!;
      expect(entry.deleted_at == null).toBe(true);
    });

    it('runs in ensureIndexes BEFORE the unique-index creation', async () => {
      if (!mongoReachable) return;
      const { closeDb, ensureIndexes } = await import('./client.ts');
      const { migrationApplied } = await import('./migrations.ts');
      const { ObjectId } = await import('mongodb');
      await closeDb();
      await dropMapleIdIndex();

      const lib = new ObjectId();
      const sharedId = 'd'.repeat(32);
      await db!.collection('assets').insertMany([
        {
          _id: new ObjectId(),
          folder_id: lib,
          filename: 'z.dng',
          abs_path: '/lib/a/z.dng',
          fileinfo: [{ path: 'a', filename: 'z.dng', library_id: lib }],
          maple_id: sharedId,
          size: 1,
          mtime: 1,
          rating: 0,
          flag: 0,
          color_label: '',
          indexed_at: '2026-05-01T00:00:00Z',
        },
        {
          _id: new ObjectId(),
          folder_id: lib,
          filename: 'z.dng',
          abs_path: '/lib/b/z.dng',
          fileinfo: [{ path: 'b', filename: 'z.dng', library_id: lib }],
          maple_id: sharedId,
          size: 1,
          mtime: 1,
          rating: 0,
          flag: 0,
          color_label: '',
          indexed_at: '2026-05-02T00:00:00Z',
        },
      ] as never);

      // ensureIndexes must merge dupes THEN successfully create the unique
      // index. If the ordering is wrong, createIndex throws (DuplicateKey).
      await ensureIndexes();
      expect(await migrationApplied(db!, 'merge-duplicate-assets-2026-05-21')).toBe(true);

      const rows = await db!.collection('assets').find({ maple_id: sharedId }).toArray();
      expect(rows).toHaveLength(1);

      // Unique partial index must be back in place after the merge.
      const indexes = await db!.collection('assets').indexes();
      const mapleIdIdx = indexes.find((i: { name?: unknown }) => i.name === 'maple_id_1');
      expect(mapleIdIdx).toBeDefined();
      expect((mapleIdIdx as { unique?: boolean }).unique).toBe(true);
    });
  });
});
