/**
 * Integration tests for `trashAssetById` / `restoreAssetById` (#2630),
 * focused on the multi-location selector regression flagged in the #2695
 * review: the plain "first non-deleted" fileinfo pick is unsafe when an
 * earlier entry is missing-tagged but not deleted — it targets the
 * stale/offline copy instead of the live one. Mirrors
 * `relocate-asset.test.ts`'s "multi-location asset: relocate targets the
 * live entry, not a missing-tagged one" test, applied to trash + restore.
 *
 * Real temp directories + real files AND a real MongoDB, same
 * connect-or-skip-gracefully pattern as the sibling `library/*.test.ts`
 * files.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDb } from '../db/client.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { trashAssetById, restoreAssetById } from './asset-trash.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_asset_trash_test_${process.pid}`;
const ORIGINAL_MONGO_DB = process.env.MAPLE_MONGO_DB;
const ORIGINAL_MONGO_URI = process.env.MAPLE_MONGO_URI;

let client: MongoClient | null = null;
let db: Db | null = null;
let root: string;
let folderId: ObjectId;

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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-trash-'));
  client = await tryConnect();
  if (!client) return;
  await closeDb();
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();

  folderId = new ObjectId();
  await db.collection('folders').insertOne({
    _id: folderId,
    path: root,
    slug: 'asset-trash-test',
    label: 'asset-trash-test',
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  } as never);
  invalidateLibraryRoots();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
  if (ORIGINAL_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = ORIGINAL_MONGO_DB;
  if (ORIGINAL_MONGO_URI === undefined) delete process.env.MAPLE_MONGO_URI;
  else process.env.MAPLE_MONGO_URI = ORIGINAL_MONGO_URI;
  await closeDb();
});

async function write(rel: string, content: string): Promise<string> {
  const abs = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}
async function exists(rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, ...rel.split('/')));
    return true;
  } catch {
    return false;
  }
}
async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
}

type AssetRow = {
  fileinfo: Array<{
    path: string;
    filename: string;
    library_id: ObjectId;
    deleted_at?: string | null;
    missing_since?: Date | string | null;
  }>;
  deleted_at: string | null;
};

async function fetchAssetRow(d: Db, id: ObjectId): Promise<AssetRow> {
  return (await d.collection('assets').findOne({ _id: id })) as unknown as AssetRow;
}

describe('trashAssetById / restoreAssetById — multi-location selector', () => {
  test('trash: targets the live entry, not a missing-tagged one', async () => {
    if (!db) return;
    await write('live/IMG_9.dng', 'pixels');
    const id = new ObjectId();
    // Same shape as relocate-asset.test.ts's regression fixture: the
    // FIRST fileinfo entry is missing-tagged (stale/offline location),
    // the SECOND is live. The plain "first non-deleted" pick would target
    // the stale one.
    await db.collection('assets').insertOne({
      _id: id,
      fileinfo: [
        {
          path: 'stale',
          filename: 'IMG_9.dng',
          library_id: folderId,
          deleted_at: null,
          missing_since: new Date(),
        },
        { path: 'live', filename: 'IMG_9.dng', library_id: folderId, deleted_at: null },
      ],
      size: 6,
      mtime: 1_700_000_000_000,
      deleted_at: null,
    } as never);

    const outcome = await trashAssetById(id);
    expect(outcome.kind).toBe('ok');

    // The LIVE copy moved to trash; the stale-tagged entry's (nonexistent)
    // file was never touched.
    expect(await exists('live/IMG_9.dng')).toBe(false);
    expect(await read('.maple/trash/live/IMG_9.dng')).toBe('pixels');

    const row = await fetchAssetRow(db, id);
    expect(row.deleted_at).not.toBeNull();
    const staleEntry = row.fileinfo.find((f) => f.path === 'stale');
    const liveEntry = row.fileinfo.find((f) => f.path.startsWith('.maple/trash'));
    expect(staleEntry).toBeTruthy(); // untouched
    expect(liveEntry?.path).toBe('.maple/trash/live');
  });

  test('restore: targets the trashed (formerly-live) entry, not a missing-tagged one', async () => {
    if (!db) return;
    await write('live/IMG_9.dng', 'pixels');
    const id = new ObjectId();
    await db.collection('assets').insertOne({
      _id: id,
      fileinfo: [
        {
          path: 'stale',
          filename: 'IMG_9.dng',
          library_id: folderId,
          deleted_at: null,
          missing_since: new Date(),
        },
        { path: 'live', filename: 'IMG_9.dng', library_id: folderId, deleted_at: null },
      ],
      size: 6,
      mtime: 1_700_000_000_000,
      deleted_at: null,
    } as never);

    const trashOutcome = await trashAssetById(id);
    expect(trashOutcome.kind).toBe('ok');

    // After trash, BOTH fileinfo entries are missing_since-free (only the
    // trashed one's path/filename changed) — restoreAssetById must not
    // fall back to the naive "first non-deleted" pick, which would target
    // the still-stale-tagged `stale` entry instead of the trashed one.
    const restoreOutcome = await restoreAssetById(id);
    expect(restoreOutcome.kind).toBe('ok');

    expect(await read('live/IMG_9.dng')).toBe('pixels');
    const row = await fetchAssetRow(db, id);
    expect(row.deleted_at).toBeNull();
    const staleEntry = row.fileinfo.find((f) => f.path === 'stale');
    const restoredEntry = row.fileinfo.find((f) => f.path === 'live');
    expect(staleEntry).toBeTruthy(); // still untouched
    expect(restoredEntry).toBeTruthy();
  });
});
