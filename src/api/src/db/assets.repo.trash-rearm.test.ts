/**
 * Assets repo trash/restore meili re-arm unit tests (#2354). Requires a
 * running MongoDB; skip gracefully if unreachable. Split out of
 * assets.repo.test.ts to keep both files under the file-size budget —
 * mirrors the migrations.*.test.ts split (own connection boilerplate per
 * file, same pattern as changes.repo.test.ts).
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { markSoftDeleted, restoreFromTrash } from './assets.repo.ts';
import { closeDb } from './client.ts';
import { pendingEnrichment } from './schema.ts';
import { buildClaimQuery } from '../workers/run-stage.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_assets_repo_trash_rearm_test_${process.pid}`;
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

describe('assets.repo — trash/restore meili re-arm (#2354)', () => {
  // Trash + restore must re-arm the meili stage in the SAME update as the
  // deleted_at flip, so the stage (not the trash route's best-effort inline
  // Meilisearch calls) guarantees search-index convergence: tombstone while
  // trashed, full-document rebuild after restore.
  it('markSoftDeleted re-arms the meili stage atomically and leaves the row claimable', async () => {
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
    // A fully-indexed asset: meili stage done at current target, and
    // previously dead-lettered bookkeeping to prove the reset clears it.
    const id = await seedAsset(db, {
      folder_id: libraryId,
      stages: {
        meili: {
          version: 7,
          attempts: 3,
          last_error: 'boom',
          processed_at: new Date(),
          dead: true,
        },
      },
    });
    await markSoftDeleted({
      id,
      libraryRoot: '/lib',
      libraryId,
      newAbsPath: '/lib/.maple/trash/a.dng',
      originalAbsPath: '/lib/a.dng',
      dbOverride: db,
    });
    const row = (await db.collection('assets').findOne({ _id: id })) as unknown as {
      stages: {
        meili: {
          version: number;
          attempts: number;
          last_error: unknown;
          processed_at: unknown;
          dead: boolean;
        };
      };
    };
    expect(row.stages.meili.version).toBe(0);
    expect(row.stages.meili.attempts).toBe(0);
    expect(row.stages.meili.last_error).toBeNull();
    expect(row.stages.meili.processed_at).toBeNull();
    expect(row.stages.meili.dead).toBe(false);
    // The trashed row must actually be reachable by the stage's claim
    // query (the trash-location fileinfo entry stays live per-entry) —
    // that reachability is what lets meiliHandler's deleted_at branch
    // tombstone the search document with retry/backoff.
    const claim = buildClaimQuery('meili', 7, [], new Set());
    const claimed = await db
      .collection('assets')
      .find(claim as never)
      .toArray();
    expect(claimed.map((d) => d._id.toHexString())).toContain(id.toHexString());
  });

  it('restoreFromTrash re-arms the meili stage atomically in the same update that clears deleted_at', async () => {
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
    // Trashed asset whose meili stage already re-ran (tombstone pass)
    // and is done again at the current target version.
    const id = await seedAsset(db, {
      folder_id: libraryId,
      fileinfo: [
        { path: '.maple/trash', filename: 'a.dng', library_id: libraryId, deleted_at: null },
      ],
      deleted_at: '2026-01-01T00:00:00Z',
      original_path: '/lib/a.dng',
      stages: {
        meili: {
          version: 7,
          attempts: 0,
          last_error: null,
          processed_at: new Date(),
          dead: false,
        },
      },
    });
    await restoreFromTrash({
      id,
      libraryRoot: '/lib',
      libraryId,
      newAbsPath: '/lib/a.dng',
      size: 2048,
      mtimeMs: Date.UTC(2026, 5, 1),
      dbOverride: db,
    });
    const row = (await db.collection('assets').findOne({ _id: id })) as unknown as {
      deleted_at: unknown;
      stages: {
        meili: {
          version: number;
          attempts: number;
          last_error: unknown;
          processed_at: unknown;
          dead: boolean;
        };
      };
    };
    expect(row.deleted_at).toBeNull();
    expect(row.stages.meili.version).toBe(0);
    expect(row.stages.meili.attempts).toBe(0);
    expect(row.stages.meili.last_error).toBeNull();
    expect(row.stages.meili.processed_at).toBeNull();
    expect(row.stages.meili.dead).toBe(false);
    // Restored row is claimable again → the stage rebuilds the FULL
    // Meilisearch document (facets included), superseding the route's
    // partial fast-path upsert.
    const claim = buildClaimQuery('meili', 7, [], new Set());
    const claimed = await db
      .collection('assets')
      .find(claim as never)
      .toArray();
    expect(claimed.map((d) => d._id.toHexString())).toContain(id.toHexString());
  });
});
