/**
 * mergeDuplicateAssets heal-migration tests. The unique partial index on
 * maple_id forbids same-maple_id rows in the steady state, so tests for
 * the heal migration MUST drop the index in setup to manufacture the
 * dup-state; ensureIndexes then re-creates the index on the merged
 * (clean) state.
 *
 * Skip-passes when Mongo is unreachable (same pattern as client.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { withTestDb } from './test-db.test-helpers.ts';

const TEST_DB = withTestDb(`maple_test_migrations_merge_${process.pid}`);
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
    console.log('[migrations.merge-duplicates.test] skipping: MongoDB unreachable');
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
// Asset fixture helper — every test below inserts rows that only differ in a
// handful of fields (library, maple_id, path/filename, the survivor-pick
// fields, and whatever fileinfo[] the case is pinning). Factoring the
// constant fields (size/mtime/color_label defaults) out here keeps each
// test's insertMany call to the one or two fields that actually matter for
// that case, instead of repeating the full ~11-field document literal.
// ---------------------------------------------------------------------------

interface FileinfoEntry {
  path: string;
  filename: string;
  library_id: ObjectId;
  deleted_at?: string | null;
}

interface AssetFixtureOpts {
  id?: ObjectId;
  library: ObjectId;
  mapleId: string;
  path: string;
  filename?: string;
  /** Override the whole fileinfo[] array for cases pinning a multi-entry union. */
  fileinfo?: FileinfoEntry[];
  rating?: number;
  flag?: number;
  colorLabel?: string;
  indexedAt: string;
}

function makeAsset(opts: AssetFixtureOpts) {
  const filename = opts.filename ?? 'x.dng';
  const fileinfo = opts.fileinfo ?? [
    { path: opts.path, filename, library_id: opts.library } satisfies FileinfoEntry,
  ];
  return {
    _id: opts.id ?? new ObjectId(),
    folder_id: opts.library,
    filename,
    abs_path: `/lib/${opts.path}/${filename}`,
    fileinfo,
    maple_id: opts.mapleId,
    size: 1,
    mtime: 1,
    rating: opts.rating ?? 0,
    flag: opts.flag ?? 0,
    color_label: opts.colorLabel ?? '',
    indexed_at: opts.indexedAt,
  };
}

describe('mergeDuplicateAssets', () => {
  async function dropMapleIdIndex(): Promise<void> {
    // Drop both index names — `maple_id_gt_1` is the post-swap canonical
    // name, `maple_id_1` is the legacy predecessor that ensureIndexes
    // drops once on boot. Either may be present depending on the test's
    // setup ordering.
    for (const name of ['maple_id_gt_1', 'maple_id_1']) {
      try {
        await db!.collection('assets').dropIndex(name);
      } catch {
        // IndexNotFound — fine.
      }
    }
  }

  it('collapses rows sharing a maple_id into one with union fileinfo[]', async () => {
    if (!mongoReachable) return;
    const { mergeDuplicateAssets } = await import('./migrations.ts');
    await dropMapleIdIndex();

    const lib = new ObjectId();
    const sharedId = 'a'.repeat(32);

    await db!.collection('assets').insertMany([
      makeAsset({
        library: lib,
        mapleId: sharedId,
        path: 'a',
        rating: 5,
        flag: 1,
        colorLabel: 'red',
        indexedAt: '2026-05-01T00:00:00Z',
      }),
      makeAsset({ library: lib, mapleId: sharedId, path: 'b', indexedAt: '2026-05-10T00:00:00Z' }),
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
    const sorted = (rows[0]!.fileinfo ?? []).map((e: { path: string }) => e.path).sort();
    expect(sorted).toEqual(['a', 'b']);
  });

  it('idempotent — does not touch already-unique rows', async () => {
    if (!mongoReachable) return;
    const { mergeDuplicateAssets } = await import('./migrations.ts');
    await dropMapleIdIndex();

    const lib = new ObjectId();
    await db!.collection('assets').insertOne(
      makeAsset({
        library: lib,
        mapleId: 'b'.repeat(32),
        path: '',
        filename: 'solo.dng',
        indexedAt: '2026-05-01T00:00:00Z',
      }) as never,
    );

    const r1 = await mergeDuplicateAssets(db!);
    expect(r1.merged_groups).toBe(0);
    const r2 = await mergeDuplicateAssets(db!);
    expect(r2.merged_groups).toBe(0);
  });

  it('preserves survivor _id (no reinsert; just $set fileinfo)', async () => {
    if (!mongoReachable) return;
    const { mergeDuplicateAssets } = await import('./migrations.ts');
    await dropMapleIdIndex();

    const lib = new ObjectId();
    const survivorId = new ObjectId();
    const loserId = new ObjectId();
    const sharedId = 'c'.repeat(32);

    await db!.collection('assets').insertMany([
      makeAsset({
        id: survivorId,
        library: lib,
        mapleId: sharedId,
        path: 'A',
        filename: 'y.dng',
        rating: 3,
        indexedAt: '2026-05-01T00:00:00Z',
      }),
      makeAsset({
        id: loserId,
        library: lib,
        mapleId: sharedId,
        path: 'B',
        filename: 'y.dng',
        indexedAt: '2026-05-09T00:00:00Z',
      }),
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
    await dropMapleIdIndex();

    const lib = new ObjectId();
    const sharedId = 'e'.repeat(32);
    const rows = ['a', 'b', 'c', 'd'].map((p, i) =>
      makeAsset({
        library: lib,
        mapleId: sharedId,
        path: p,
        filename: 'z.dng',
        indexedAt: `2026-05-0${1 + i}T00:00:00Z`,
      }),
    );
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
    await dropMapleIdIndex();

    const lib = new ObjectId();
    const sharedId = 'f'.repeat(32);
    const sameEntry: FileinfoEntry = { path: 'shared', filename: 's.dng', library_id: lib };

    await db!.collection('assets').insertMany([
      makeAsset({
        library: lib,
        mapleId: sharedId,
        path: 'shared',
        filename: 's.dng',
        fileinfo: [sameEntry, { path: 'a', filename: 's.dng', library_id: lib }],
        indexedAt: '2026-05-01T00:00:00Z',
      }),
      makeAsset({
        library: lib,
        mapleId: sharedId,
        path: 'shared',
        filename: 's.dng',
        fileinfo: [sameEntry, { path: 'b', filename: 's.dng', library_id: lib }],
        indexedAt: '2026-05-02T00:00:00Z',
      }),
    ] as never);

    await mergeDuplicateAssets(db!);
    const merged = await db!.collection('assets').findOne({ maple_id: sharedId });
    // sameEntry appears in both → counts once. plus 'a' and 'b' → 3 total.
    expect(merged!.fileinfo).toHaveLength(3);
  });

  it("de-dup key tolerates '|' inside path/filename (JSON-encoded key)", async () => {
    if (!mongoReachable) return;
    const { mergeDuplicateAssets } = await import('./migrations.ts');
    await dropMapleIdIndex();

    const lib = new ObjectId();
    const sharedId = '7'.repeat(32);
    // Two distinct (path, filename) pairs that would collide under a naive
    // `${path}|${filename}` key: 'a|b' + 'c' vs 'a' + 'b|c'. The JSON-encoded
    // key keeps them separate, so the union must contain both entries.
    await db!.collection('assets').insertMany([
      makeAsset({
        library: lib,
        mapleId: sharedId,
        path: 'a|b',
        filename: 'c',
        indexedAt: '2026-05-01T00:00:00Z',
      }),
      makeAsset({
        library: lib,
        mapleId: sharedId,
        path: 'a',
        filename: 'b|c',
        indexedAt: '2026-05-02T00:00:00Z',
      }),
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
    await dropMapleIdIndex();

    const lib = new ObjectId();
    const sharedId = '8'.repeat(32);
    // Same (lib, path, filename) across two rows: one tombstoned, the other
    // live. The merged union must keep the live entry, not the tombstone.
    await db!.collection('assets').insertMany([
      makeAsset({
        library: lib,
        mapleId: sharedId,
        path: 'here',
        filename: 'q.dng',
        fileinfo: [
          { path: 'here', filename: 'q.dng', library_id: lib, deleted_at: '2026-05-01T00:00:00Z' },
        ],
        indexedAt: '2026-05-01T00:00:00Z',
      }),
      makeAsset({
        library: lib,
        mapleId: sharedId,
        path: 'here',
        filename: 'q.dng',
        fileinfo: [{ path: 'here', filename: 'q.dng', library_id: lib, deleted_at: null }],
        indexedAt: '2026-05-02T00:00:00Z',
      }),
    ] as never);

    await mergeDuplicateAssets(db!);
    const survivor = await db!.collection('assets').findOne({ maple_id: sharedId });
    expect(survivor).not.toBeNull();
    expect(survivor!.fileinfo).toHaveLength(1);
    const entry = (survivor!.fileinfo as Array<{ deleted_at?: string | null }>)[0]!;
    expect(entry.deleted_at == null).toBe(true);
  });

  it('handles multiple duplicate groups in a single pass without cross-group mixing', async () => {
    if (!mongoReachable) return;
    const { mergeDuplicateAssets } = await import('./migrations.ts');
    await dropMapleIdIndex();

    // Batching re-partitions a single find() result back into groups in
    // memory — this pins that the re-partition is keyed correctly (not, say,
    // interleaved by insertion order) when several groups are merged in the
    // same call.
    const lib = new ObjectId();
    const sharedIdA = '1'.repeat(32);
    const sharedIdB = '2'.repeat(32);
    const sharedIdC = '3'.repeat(32);

    await db!.collection('assets').insertMany([
      // Group A: 2 rows, survivor keeps rating 9.
      makeAsset({
        library: lib,
        mapleId: sharedIdA,
        path: 'groupA/1',
        filename: 'a.dng',
        rating: 9,
        indexedAt: '2026-05-01T00:00:00Z',
      }),
      makeAsset({
        library: lib,
        mapleId: sharedIdA,
        path: 'groupA/2',
        filename: 'a.dng',
        indexedAt: '2026-05-05T00:00:00Z',
      }),
      // Group B: 3 rows, survivor keeps rating 7.
      makeAsset({
        library: lib,
        mapleId: sharedIdB,
        path: 'groupB/1',
        filename: 'b.dng',
        rating: 7,
        indexedAt: '2026-04-01T00:00:00Z',
      }),
      makeAsset({
        library: lib,
        mapleId: sharedIdB,
        path: 'groupB/2',
        filename: 'b.dng',
        indexedAt: '2026-04-02T00:00:00Z',
      }),
      makeAsset({
        library: lib,
        mapleId: sharedIdB,
        path: 'groupB/3',
        filename: 'b.dng',
        indexedAt: '2026-04-03T00:00:00Z',
      }),
      // Solo row, not part of any duplicate group — must be untouched.
      makeAsset({
        library: lib,
        mapleId: sharedIdC,
        path: 'solo',
        filename: 'c.dng',
        rating: 3,
        indexedAt: '2026-06-01T00:00:00Z',
      }),
    ] as never);

    const result = await mergeDuplicateAssets(db!);
    expect(result.scanned_groups).toBe(2);
    expect(result.merged_groups).toBe(2);
    expect(result.deleted_rows).toBe(3); // 1 loser in A + 2 losers in B

    const groupA = await db!.collection('assets').find({ maple_id: sharedIdA }).toArray();
    expect(groupA).toHaveLength(1);
    expect(groupA[0]!.rating).toBe(9);
    expect(groupA[0]!.fileinfo).toHaveLength(2);

    const groupB = await db!.collection('assets').find({ maple_id: sharedIdB }).toArray();
    expect(groupB).toHaveLength(1);
    expect(groupB[0]!.rating).toBe(7);
    expect(groupB[0]!.fileinfo).toHaveLength(3);

    const solo = await db!.collection('assets').find({ maple_id: sharedIdC }).toArray();
    expect(solo).toHaveLength(1);
    expect(solo[0]!.rating).toBe(3);
  });

  it('runs in ensureIndexes BEFORE the unique-index creation', async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureIndexes } = await import('./client.ts');
    const { migrationApplied } = await import('./migrations.ts');
    await closeDb();
    await dropMapleIdIndex();

    const lib = new ObjectId();
    const sharedId = 'd'.repeat(32);
    await db!.collection('assets').insertMany([
      makeAsset({
        library: lib,
        mapleId: sharedId,
        path: 'a',
        filename: 'z.dng',
        indexedAt: '2026-05-01T00:00:00Z',
      }),
      makeAsset({
        library: lib,
        mapleId: sharedId,
        path: 'b',
        filename: 'z.dng',
        indexedAt: '2026-05-02T00:00:00Z',
      }),
    ] as never);

    // ensureIndexes must merge dupes THEN successfully create the unique
    // index. If the ordering is wrong, createIndex throws (DuplicateKey).
    await ensureIndexes();
    expect(await migrationApplied(db!, 'merge-duplicate-assets-2026-05-21')).toBe(true);

    const rows = await db!.collection('assets').find({ maple_id: sharedId }).toArray();
    expect(rows).toHaveLength(1);

    // Unique partial index must be back in place after the merge.
    // Post-swap the canonical name is `maple_id_gt_1` (see comment block
    // in client.ts).
    const indexes = await db!.collection('assets').indexes();
    const mapleIdIdx = indexes.find((i: { name?: unknown }) => i.name === 'maple_id_gt_1');
    expect(mapleIdIdx).toBeDefined();
    expect((mapleIdIdx as { unique?: boolean }).unique).toBe(true);
  });
});
