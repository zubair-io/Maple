/**
 * backfillFolderSlugs and fileinfo compound-index uniqueness-hardening tests.
 * These cover the M1 (API library addressing) additions to migrations.ts.
 *
 * Skip-passes when Mongo is unreachable (same pattern as migrations.backfills.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';

const TEST_DB = `maple_test_migrations_folder_slugs_${process.pid}`;
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
    console.log('[migrations.folder-slugs.test] skipping: MongoDB unreachable');
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

// ---------------------------------------------------------------------------
// Task 3: backfillFolderSlugs
// ---------------------------------------------------------------------------

describe('backfillFolderSlugs', () => {
  it('mints unique stable slugs from label and is idempotent', async () => {
    if (!mongoReachable) return;
    const { backfillFolderSlugs } = await import('./migrations.ts');
    await db!.collection('folders').insertMany([
      {
        path: '/srv/a/Library',
        label: 'Library',
        last_scan: null,
        file_count: 0,
        created_at: '2026-06-16T00:00:00Z',
      },
      {
        path: '/srv/b/Library',
        label: 'Library',
        last_scan: null,
        file_count: 0,
        created_at: '2026-06-16T00:00:00Z',
      },
    ]);
    await backfillFolderSlugs(db!);
    const rows = await db!.collection('folders').find().sort({ _id: 1 }).toArray();
    expect(rows[0]!.slug).toBe('library');
    expect(rows[1]!.slug).toBe('library-2');
    // idempotent: rerun changes nothing
    const before = rows.map((r) => r.slug);
    await backfillFolderSlugs(db!);
    const after = (await db!.collection('folders').find().sort({ _id: 1 }).toArray()).map(
      (r) => r.slug,
    );
    expect(after).toEqual(before);
  });

  it('skips folders that already have a slug', async () => {
    if (!mongoReachable) return;
    const { backfillFolderSlugs } = await import('./migrations.ts');
    await db!.collection('folders').insertOne({
      path: '/srv/c/Photos',
      label: 'Photos',
      slug: 'my-custom-slug',
      last_scan: null,
      file_count: 0,
      created_at: '2026-06-16T00:00:00Z',
    });
    await backfillFolderSlugs(db!);
    const row = await db!.collection('folders').findOne({ path: '/srv/c/Photos' });
    // Custom slug must be preserved
    expect((row as Record<string, unknown>)?.slug).toBe('my-custom-slug');
  });

  it('batches writes across multiple bulkWrite chunks and still assigns every row a unique slug', async () => {
    if (!mongoReachable) return;
    const { backfillFolderSlugs } = await import('./migrations.ts');
    // The backfill chunks writes at 500 ops/bulkWrite — insert enough rows to
    // force 3 chunks (500 + 500 + 200) and confirm the chunk boundary doesn't
    // lose updates, double-count, or let dedupeSlug repeat a slug across the
    // boundary (taken/dedupeSlug derivation must stay sequential across chunks).
    const ROWS = 1200;
    const docs = Array.from({ length: ROWS }, (_, i) => ({
      path: `/srv/bulk/${i}`,
      label: 'Shared Label',
      last_scan: null,
      file_count: 0,
      created_at: '2026-06-16T00:00:00Z',
    }));
    await db!.collection('folders').insertMany(docs);

    const result = await backfillFolderSlugs(db!);
    expect(result.updated).toBe(ROWS);
    expect(result.skipped).toBe(0);

    const rows = await db!.collection('folders').find({ label: 'Shared Label' }).toArray();
    expect(rows).toHaveLength(ROWS);
    const slugs = rows.map((r) => r.slug as string);
    // Every row got a slug, and dedup held across the whole run, including
    // across the chunk boundary — no two rows share a slug.
    expect(new Set(slugs).size).toBe(ROWS);
    expect(slugs.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
  }, 20000);
});

// ---------------------------------------------------------------------------
// Task 2b: fileinfo compound index uniqueness hardening
// ---------------------------------------------------------------------------

describe('hardening: fileinfo compound index uniqueness', () => {
  it('leaves non-unique index in place and logs when violations exist', async () => {
    if (!mongoReachable) return;
    const { hardenFileinfoCompoundIndex } = await import('./migrations.ts');

    // Drop unique index if present from a prior ensureIndexes() run
    await db!
      .collection('assets')
      .dropIndex('fileinfo_lib_path_name_unique')
      .catch(() => undefined);
    // Ensure the non-unique base index is present before calling the hardener
    await db!
      .collection('assets')
      .createIndex(
        { 'fileinfo.library_id': 1, 'fileinfo.path': 1, 'fileinfo.filename': 1 },
        { name: 'fileinfo_lib_path_name' },
      )
      .catch(() => undefined); // idempotent — may already exist

    // Seed a duplicate tuple (no unique index to reject it now)
    const libId = new ObjectId();
    const entry = {
      library_id: libId,
      path: '2026',
      filename: 'dup.jpg',
      deleted_at: null,
      missing_since: null,
    };
    await db!.collection('assets').insertMany([
      {
        maple_id: 'ccc',
        fileinfo: [entry],
        size: 1,
        mtime: 0,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: '2026-06-16T00:00:00Z',
        deleted_at: null,
      },
      {
        maple_id: 'ddd',
        fileinfo: [entry],
        size: 1,
        mtime: 0,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: '2026-06-16T00:00:00Z',
        deleted_at: null,
      },
    ]);

    const result = await hardenFileinfoCompoundIndex(db!);
    expect(result.violations).toBeGreaterThan(0);
    expect(result.promoted).toBe(false);

    const indexes = await db!.collection('assets').indexes();
    // The unique index must NOT be present — violation detected
    expect(indexes.find((i) => i.name === 'fileinfo_lib_path_name_unique')).toBeUndefined();
    // The non-unique base index must still be there
    expect(indexes.find((i) => i.name === 'fileinfo_lib_path_name')).toBeDefined();
  });

  it('promotes to unique index when no violations exist', async () => {
    if (!mongoReachable) return;
    const { hardenFileinfoCompoundIndex } = await import('./migrations.ts');

    // Drop unique index if it exists from a prior run
    await db!
      .collection('assets')
      .dropIndex('fileinfo_lib_path_name_unique')
      .catch(() => undefined);
    // Ensure base index
    await db!
      .collection('assets')
      .createIndex(
        { 'fileinfo.library_id': 1, 'fileinfo.path': 1, 'fileinfo.filename': 1 },
        { name: 'fileinfo_lib_path_name' },
      )
      .catch(() => undefined);

    // Seed a clean set — no duplicate (library_id, path, filename) tuples
    const libId = new ObjectId();
    await db!.collection('assets').insertMany([
      {
        maple_id: 'eee',
        fileinfo: [
          {
            library_id: libId,
            path: '2026',
            filename: 'e.jpg',
            deleted_at: null,
            missing_since: null,
          },
        ],
        size: 1,
        mtime: 0,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: '2026-06-16T00:00:00Z',
        deleted_at: null,
      },
      {
        maple_id: 'fff',
        fileinfo: [
          {
            library_id: libId,
            path: '2026',
            filename: 'f.jpg',
            deleted_at: null,
            missing_since: null,
          },
        ],
        size: 1,
        mtime: 0,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: '2026-06-16T00:00:00Z',
        deleted_at: null,
      },
    ]);

    const result = await hardenFileinfoCompoundIndex(db!);
    expect(result.violations).toBe(0);
    expect(result.promoted).toBe(true);

    const indexes = await db!.collection('assets').indexes();
    const uniqueIdx = indexes.find((i) => i.name === 'fileinfo_lib_path_name_unique');
    expect(uniqueIdx).toBeDefined();
    expect(uniqueIdx!.unique).toBe(true);

    // The redundant non-unique base index must be dropped after promotion to
    // avoid write amplification (two identical index entries per write).
    expect(indexes.find((i) => i.name === 'fileinfo_lib_path_name')).toBeUndefined();
  });
});
