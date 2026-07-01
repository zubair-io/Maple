/**
 * Route-integration test: POST /api/folders/:id/scan (auto-scan-on-open, #804).
 *
 * Exercises the content-aware re-discover endpoint end-to-end through the
 * Elysia router (NOT a re-simulated DB payload). The scenario is the bug the
 * ticket fixes: a file moved within a library leaves its asset with only a
 * soft-deleted fileinfo at the OLD path. The real file now lives at a NEW
 * path under the library root. Opening the folder triggers `/scan`, which
 * re-walks the tree and relinks the moved file onto its EXISTING asset row
 * (deduped by maple_id/sha1_head): a live fileinfo is appended and the row's
 * deleted_at clears.
 *
 * Also covers the `last_scan` de-bounce: a second `/scan` inside the recent
 * window short-circuits without re-walking.
 *
 * Requires a running MongoDB (MAPLE_MONGO_URI / localhost:27017); skips
 * gracefully when Mongo is unreachable, mirroring the discover suites.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import type { MongoClient } from 'mongodb';
import { ObjectId, type Db } from 'mongodb';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryConnect } from '../workers/discover/_test-helpers.ts';

const TEST_DB = `maple_test_folders_scan_relink_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[folders.scan-relink.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../db/client.ts');
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
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

describe('POST /api/folders/:id/scan — relink on open', () => {
  it('relinks a moved file onto its existing asset row (same _id, live fileinfo appended)', async () => {
    if (!mongoReachable) return;

    const { foldersRoutes } = await import('./folders.ts');
    const { foldersCollection, assetsCollection } = await import('../db/client.ts');
    const { hashFileForId } = await import('../indexer/id.ts');
    const { blankStagesSkeleton } = await import('../workers/stages/manifest.ts');

    // Library root with the file at its NEW path only. The OLD path
    // (`old/IMG.dng`) is never written to disk — it's the location the
    // soft-deleted fileinfo still points at after the move.
    const root = await mkdtemp(path.join(os.tmpdir(), 'scan-relink-'));
    const newDir = path.join(root, 'new');
    await mkdir(newDir, { recursive: true });
    const newFile = path.join(newDir, 'IMG.dng');
    const bytes = Buffer.alloc(72 * 1024, 0x5a);
    await writeFile(newFile, bytes);

    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: 'relink-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    // Seed the asset as if the file was discovered at its OLD path and then
    // moved away: a single fileinfo entry at `old/IMG.dng`, soft-deleted, and
    // the row itself soft-deleted. maple_id + sha1_head match the file's
    // actual content (the move preserves bytes) so the discover dedup hits.
    const hashed = await hashFileForId(newFile);
    const assetsColl = await assetsCollection();
    await assetsColl.deleteMany({ maple_id: hashed.maple_id });
    const assetId = new ObjectId();
    const deletedAt = new Date().toISOString();
    await assetsColl.insertOne({
      _id: assetId,
      fileinfo: [
        {
          path: 'old',
          filename: 'IMG.dng',
          library_id: folderId,
          deleted_at: deletedAt,
        },
      ],
      rating: 0,
      flag: 0,
      color_label: '',
      exif: null,
      maple_id: hashed.maple_id,
      sha1_head: hashed.sha1_head,
      size: hashed.size,
      mtime: hashed.mtime,
      indexed_at: deletedAt,
      deleted_at: deletedAt,
      stages: blankStagesSkeleton(),
    } as never);

    // Open the folder → POST /scan re-walks and relinks.
    const res = await foldersRoutes.handle(
      new Request(`http://localhost/api/folders/${folderId.toHexString()}/scan`, {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped?: string; last_scan?: string };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBeUndefined();
    expect(body.last_scan).toBeTruthy();

    // The SAME asset row now carries a live fileinfo at the new path, and the
    // row's top-level deleted_at is cleared. No second row was inserted.
    const rows = await assetsColl.find({ maple_id: hashed.maple_id }).toArray();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row._id.equals(assetId)).toBe(true);
    expect(row.deleted_at ?? null).toBeNull();

    const live = (row.fileinfo ?? []).filter(
      (e: { deleted_at?: string | null }) => (e.deleted_at ?? null) === null,
    );
    expect(live).toHaveLength(1);
    expect(live[0]!.path).toBe('new');
    expect(live[0]!.filename).toBe('IMG.dng');

    // folders.last_scan was stamped.
    const folderDoc = await foldersColl.findOne({ _id: folderId });
    expect(folderDoc?.last_scan).toBe(body.last_scan ?? null);

    await assetsColl.deleteMany({ maple_id: hashed.maple_id });
    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it('short-circuits a second scan inside the recent window (last_scan de-bounce)', async () => {
    if (!mongoReachable) return;

    const { foldersRoutes } = await import('./folders.ts');
    const { foldersCollection } = await import('../db/client.ts');

    const root = await mkdtemp(path.join(os.tmpdir(), 'scan-debounce-'));
    const foldersColl = await foldersCollection();
    const folderResult = await foldersColl.insertOne({
      path: root,
      label: 'debounce-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const folderId = folderResult.insertedId;

    const first = await foldersRoutes.handle(
      new Request(`http://localhost/api/folders/${folderId.toHexString()}/scan`, {
        method: 'POST',
      }),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { ok: boolean; skipped?: string; last_scan?: string };
    expect(firstBody.skipped).toBeUndefined();
    const firstScan = firstBody.last_scan;

    const second = await foldersRoutes.handle(
      new Request(`http://localhost/api/folders/${folderId.toHexString()}/scan`, {
        method: 'POST',
      }),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      ok: boolean;
      skipped?: string;
      last_scan?: string;
    };
    expect(secondBody.skipped).toBe('recent');
    // last_scan unchanged — the second call did not re-walk or re-stamp.
    expect(secondBody.last_scan).toBe(firstScan);

    await foldersColl.deleteOne({ _id: folderId });
    await rm(root, { recursive: true, force: true });
  });

  it('returns 404 for an unknown folder id', async () => {
    if (!mongoReachable) return;

    const { foldersRoutes } = await import('./folders.ts');
    const res = await foldersRoutes.handle(
      new Request(`http://localhost/api/folders/${new ObjectId().toHexString()}/scan`, {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(404);
  });
});
