/**
 * Discover producer — event-stream tests.
 *
 * Split from the original discover.test.ts (#251). Covers the
 * removed-event soft-delete path and the `asset_changes` feed emitted
 * on create / modify / rename / delete.
 *
 * Requires: MAPLE_MONGO_URI (or a local MongoDB on localhost:27017).
 * Skips gracefully when Mongo is unreachable.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import type { MongoClient } from 'mongodb';
import { type Db } from 'mongodb';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryConnect } from './_test-helpers.ts';

const TEST_DB = `maple_test_discover_events_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[discover.events.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

afterAll(async () => {
  if (mongo) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {}
    try {
      await mongo.close();
    } catch {}
  }
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

describe('discover producer — events', () => {
  it('tags the location missing (not root deleted_at) when a removed event is received', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'discover-del-'));
    const file = path.join(tempDir, 'todelete.jpg');
    await writeFile(file, Buffer.alloc(50, 0xaa));
    // Keep the library root non-empty after `file` is unlinked below — the
    // removed handler refuses to tag when the root looks unmounted (#2171).
    await writeFile(path.join(tempDir, 'other.jpg'), Buffer.alloc(50, 0xbb));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: tempDir,
      label: path.basename(tempDir),
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    // Insert via created event first.
    await handleEvent({ kind: 'created', absPath: file }, folderId, tempDir);
    const coll = await assetsCollection();
    const filename = path.basename(file);
    const filter = {
      fileinfo: { $elemMatch: { library_id: folderId, filename } },
    } as never;
    const before = await coll.findOne(filter);
    expect(before).not.toBeNull();
    expect((before as Record<string, unknown>).deleted_at).toBeNull();

    // A removed event for a file that is STILL ON DISK is refused — the
    // handler stat-confirms before tagging (#2171: a present file is never
    // marked missing).
    await handleEvent({ kind: 'removed', absPath: file }, folderId, tempDir);
    const refused = await coll.findOne(filter);
    const refusedEntry = (
      refused as { fileinfo?: Array<{ filename: string; missing_since?: string }> }
    ).fileinfo!.find((e) => e.filename === filename)!;
    expect(refusedEntry.missing_since ?? null).toBeNull();

    // Now genuinely delete the file and fire removed again. The single
    // location is tagged per-entry `missing_since`; the asset root
    // `deleted_at` is NEVER touched (that is reserved for the File Provider
    // trash path). With no live entry left the asset is hidden + parked, and
    // the missing-reaper owns it from here.
    await rm(file);
    await handleEvent({ kind: 'removed', absPath: file }, folderId, tempDir);
    const after = await coll.findOne(filter);
    expect(after).not.toBeNull();
    expect((after as Record<string, unknown>).deleted_at).toBeNull();
    const entries = (
      after as {
        fileinfo?: Array<{ filename: string; missing_since?: string; missing_reason?: string }>;
      }
    ).fileinfo!;
    const entry = entries.find((e) => e.filename === filename)!;
    expect(typeof entry.missing_since).toBe('string');
    // Structured provenance for the tag (#2171).
    expect(entry.missing_reason).toBe('watch-removed');

    // Clean up.
    await coll.deleteOne(filter);
    await foldersColl.deleteOne({ _id: folderId });
    await rm(tempDir, { recursive: true, force: true });
  });

  it('keeps a deduped asset live when only ONE of its copies is removed', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');
    const { applyLiveFilter } = await import('../../routes/search/query.ts');

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'discover-dedup-del-'));
    // Two identical-content files (same bytes → same maple_id → one deduped row
    // with two fileinfo entries).
    const bytes = Buffer.alloc(64 * 1024 + 7, 0xcd);
    const copyA = path.join(tempDir, 'copyA.jpg');
    const copyB = path.join(tempDir, 'copyB.jpg');
    await writeFile(copyA, bytes);
    await writeFile(copyB, bytes);

    const foldersColl = await foldersCollection();
    const folderId = (
      await foldersColl.insertOne({
        path: tempDir,
        label: path.basename(tempDir),
        last_scan: null,
        file_count: 0,
        created_at: new Date().toISOString(),
      } as never)
    ).insertedId;

    await handleEvent({ kind: 'created', absPath: copyA }, folderId, tempDir);
    await handleEvent({ kind: 'created', absPath: copyB }, folderId, tempDir);

    const coll = await assetsCollection();
    const row = await coll.findOne({
      fileinfo: { $elemMatch: { library_id: folderId, filename: 'copyA.jpg' } },
    } as never);
    expect(row).not.toBeNull();
    // Deduped onto one row with both locations.
    expect((row as { fileinfo: unknown[] }).fileinfo).toHaveLength(2);

    // Remove ONE copy (genuinely unlink it — the handler stat-confirms). The
    // OTHER copy is still on disk → the asset must stay visible (the bug this
    // fixes: the whole row used to be soft-deleted).
    await rm(copyA);
    await handleEvent({ kind: 'removed', absPath: copyA }, folderId, tempDir);

    const id = (row as { _id: unknown })._id;
    const stillLive = await coll.findOne(applyLiveFilter({ _id: id } as never) as never);
    expect(stillLive).not.toBeNull(); // visible — copyB keeps it live
    expect((stillLive as { deleted_at?: string | null }).deleted_at).toBeNull();
    const fileinfo = (
      stillLive as {
        fileinfo: Array<{ filename: string; missing_since?: string | null }>;
      }
    ).fileinfo;
    const a = fileinfo.find((e) => e.filename === 'copyA.jpg')!;
    const b = fileinfo.find((e) => e.filename === 'copyB.jpg')!;
    expect(typeof a.missing_since).toBe('string'); // removed copy tagged
    expect(b.missing_since ?? null).toBeNull(); // surviving copy untouched

    await coll.deleteOne({ _id: id } as never);
    await foldersColl.deleteOne({ _id: folderId });
    await rm(tempDir, { recursive: true, force: true });
  });

  it('emits asset_changes rows on create / modify / rename / soft-delete', async () => {
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection, assetChangesCollection } =
      await import('../../db/client.ts');

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'discover-changes-'));
    const file = path.join(tempDir, 'feed.jpg');
    await writeFile(file, Buffer.alloc(64, 0x33));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      abs_path: tempDir,
      name: path.basename(tempDir),
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;
    const coll = await assetsCollection();
    const changesColl = await assetChangesCollection();
    await changesColl.deleteMany({});

    // create → expect a "create" change row.
    await handleEvent({ kind: 'created', absPath: file }, folderId, tempDir);
    let rows = await changesColl.find({ abs_path: file }).sort({ cursor: 1 }).toArray();
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe('create');

    // modify → "update"
    await handleEvent({ kind: 'modified', absPath: file }, folderId, tempDir);
    rows = await changesColl.find({ abs_path: file }).sort({ cursor: 1 }).toArray();
    expect(rows.length).toBe(2);
    expect(rows[1]!.kind).toBe('update');

    // rename — give chokidar a new path
    const newPath = path.join(tempDir, 'feed-renamed.jpg');
    await writeFile(newPath, Buffer.alloc(64, 0x33));
    await handleEvent({ kind: 'renamed', absPath: newPath, fromPath: file }, folderId, tempDir);
    const renamedRows = await changesColl.find({ abs_path: newPath }).sort({ cursor: 1 }).toArray();
    expect(renamedRows.length).toBe(1);
    expect(renamedRows[0]!.kind).toBe('update');

    // soft-delete → "delete" (unlink first — the handler stat-confirms; the
    // original `file` at the pre-rename path keeps the root non-empty)
    await rm(newPath);
    await handleEvent({ kind: 'removed', absPath: newPath }, folderId, tempDir);
    const deleted = await changesColl.find({ abs_path: newPath, kind: 'delete' }).toArray();
    expect(deleted.length).toBe(1);

    // Clean up.
    await coll.deleteMany({ folder_id: folderId });
    await changesColl.deleteMany({ folder_id: folderId });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(tempDir, { recursive: true, force: true });
  });

  it('re-arms the meili stage (all five fields) on a rename event', async () => {
    // #2357: a rename rewrites `fileinfo[].filename` — the highest-weight
    // lexical field in the Meilisearch index — but only via `$set`. Without
    // re-arming `stages.meili` the search document is never re-synced and
    // goes permanently stale.
    if (!mongoReachable) return;

    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'discover-meili-rename-'));
    const file = path.join(tempDir, 'meili-src.jpg');
    await writeFile(file, Buffer.alloc(64, 0x55));

    const foldersColl = await foldersCollection();
    const folderId = (
      await foldersColl.insertOne({
        path: tempDir,
        label: path.basename(tempDir),
        last_scan: null,
        file_count: 0,
        created_at: new Date().toISOString(),
      } as never)
    ).insertedId;

    await handleEvent({ kind: 'created', absPath: file }, folderId, tempDir);
    const coll = await assetsCollection();
    const filter = {
      fileinfo: { $elemMatch: { library_id: folderId, filename: 'meili-src.jpg' } },
    } as never;
    const before = await coll.findOne(filter);
    expect(before).not.toBeNull();
    const id = (before as { _id: unknown })._id;

    // Simulate a stage that already dead-lettered — the rename must fully
    // re-arm it (all five fields), not just bump the version.
    await coll.updateOne({ _id: id } as never, {
      $set: {
        'stages.meili.version': 3,
        'stages.meili.dead': true,
        'stages.meili.attempts': 5,
        'stages.meili.last_error': 'boom',
        'stages.meili.processed_at': '2024-01-01T00:00:00.000Z',
      },
    });

    const newPath = path.join(tempDir, 'meili-renamed.jpg');
    await writeFile(newPath, Buffer.alloc(64, 0x55));
    await handleEvent({ kind: 'renamed', absPath: newPath, fromPath: file }, folderId, tempDir);

    const after = (await coll.findOne({ _id: id } as never)) as {
      stages?: {
        meili?: {
          version: number;
          dead: boolean;
          attempts: number;
          last_error: unknown;
          processed_at: unknown;
        };
      };
    } | null;
    expect(after?.stages?.meili?.version).toBe(0);
    expect(after?.stages?.meili?.dead).toBe(false);
    expect(after?.stages?.meili?.attempts).toBe(0);
    expect(after?.stages?.meili?.last_error).toBeNull();
    expect(after?.stages?.meili?.processed_at).toBeNull();

    await coll.deleteOne({ _id: id } as never);
    await foldersColl.deleteOne({ _id: folderId });
    await rm(tempDir, { recursive: true, force: true });
  });

  it('refuses events whose absPath is inside the `.maple/` cache (defense-in-depth)', async () => {
    // Regression for #1186: if any producer (current or future) hands the
    // handler a path inside `.maple/`, the handler must refuse rather than
    // insert a phantom row — even with the sweeper-side filter in place.
    if (!mongoReachable) return;
    const { handleEvent } = await import('./index.ts');
    const { assetsCollection, foldersCollection } = await import('../../db/client.ts');

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'discover-maple-cache-'));
    const cacheDir = path.join(tempDir, '.maple', 'thumbs');
    await mkdir(cacheDir, { recursive: true });
    const phantom = path.join(cacheDir, 'cafe.jpg');
    await writeFile(phantom, Buffer.alloc(50, 0xab));

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: tempDir,
      label: path.basename(tempDir),
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    // Every event kind must be refused.
    await handleEvent({ kind: 'created', absPath: phantom }, folderId, tempDir);
    await handleEvent({ kind: 'modified', absPath: phantom }, folderId, tempDir);
    await handleEvent({ kind: 'removed', absPath: phantom }, folderId, tempDir);
    await handleEvent(
      { kind: 'renamed', absPath: path.join(tempDir, 'oops.jpg'), fromPath: phantom },
      folderId,
      tempDir,
    );

    const coll = await assetsCollection();
    const rows = await coll.find({ 'fileinfo.library_id': folderId }).toArray();
    expect(rows).toEqual([]);

    await coll.deleteMany({ 'fileinfo.library_id': folderId });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(tempDir, { recursive: true, force: true });
  });
});
