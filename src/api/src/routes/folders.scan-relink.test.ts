/**
 * Route-integration test: POST /api/folders/:id/scan (auto-scan-on-open, #804).
 *
 * Exercises the content-aware re-discover endpoint end-to-end through the
 * Elysia router (NOT a re-simulated DB payload). The scenario is the bug the
 * ticket fixes: a file moved within a library leaves its asset with only a
 * soft-deleted location at the OLD path. The real file now lives at a NEW path
 * under the library root. Opening the folder triggers `/scan`, which re-walks
 * the tree and relinks the moved file onto its EXISTING asset row (deduped by
 * maple_id/sha1_head): a live location is appended and the row's deleted_at
 * clears.
 *
 * Also covers the `last_scan` de-bounce: a second `/scan` inside the recent
 * window short-circuits without re-walking.
 *
 * The handler reaches `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the block.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { ObjectId } from '../db/object-id.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { Elysia } from 'elysia';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { hashFileForId } from '../indexer/id.ts';
import { ALL_STAGE_NAMES } from '../workers/stages/manifest.ts';
import { foldersRoutes } from './folders.ts';

interface LocationRow {
  path: string;
  filename: string;
  deleted_at: string | null;
  missing_since: string | null;
}

let live: LiveTestDatabase;
let roots: string[] = [];

beforeEach(async () => {
  live = await createLiveTestDatabase();
  roots = [];
  invalidateLibraryRoots();
});

afterEach(async () => {
  live.close();
  invalidateLibraryRoots();
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function scan(folderId: string): Promise<Response> {
  const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
  return app.handle(
    new Request(`http://localhost/api/folders/${folderId}/scan`, { method: 'POST' }),
  );
}

describe('POST /api/folders/:id/scan — relink on open', () => {
  it('relinks a moved file onto its existing asset row (same id, live location appended)', async () => {
    // Library root with the file at its NEW path only. The OLD path
    // (`old/IMG.dng`) is never written to disk — it's the location the
    // soft-deleted entry still points at after the move.
    const root = await makeRoot('scan-relink-');
    const newDir = path.join(root, 'new');
    await mkdir(newDir, { recursive: true });
    const newFile = path.join(newDir, 'IMG.dng');
    await writeFile(newFile, Buffer.alloc(72 * 1024, 0x5a));

    const folderId = insertFolder(live.db, { path: root, slug: 'relink-test' });

    // Seed the asset as if the file was discovered at its OLD path and then
    // moved away: a single location at `old/IMG.dng`, soft-deleted, and the row
    // itself soft-deleted. maple_id + sha1_head match the file's actual content
    // (the move preserves bytes) so the discover dedup hits.
    const hashed = await hashFileForId(newFile);
    const assetId = new ObjectId().toHexString();
    const deletedAt = new Date().toISOString();
    run(
      live.db,
      `INSERT INTO assets
         (id, size, mtime, indexed_at, maple_id, sha1_head, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      assetId,
      hashed.size,
      hashed.mtime,
      deletedAt,
      hashed.maple_id,
      hashed.sha1_head,
      deletedAt,
    );
    run(
      live.db,
      `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename, deleted_at)
       VALUES (?, 0, ?, 'old', 'IMG.dng', ?)`,
      assetId,
      folderId,
      deletedAt,
    );
    for (const stage of ALL_STAGE_NAMES) {
      run(live.db, `INSERT INTO stage_state (asset_id, stage) VALUES (?, ?)`, assetId, stage);
    }

    // Open the folder → POST /scan re-walks and relinks.
    const res = await scan(folderId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipped?: string; last_scan?: string };
    expect(body.ok).toBe(true);
    expect(body.skipped).toBeUndefined();
    expect(body.last_scan).toBeTruthy();

    // The SAME asset row now carries a live location at the new path, and the
    // row's own deleted_at is cleared. No second row was inserted.
    const rows = live.db
      .query(`SELECT id, deleted_at FROM assets WHERE maple_id = ?`)
      .all(hashed.maple_id) as Array<{ id: string; deleted_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(assetId);
    expect(rows[0]!.deleted_at).toBeNull();

    const liveEntries = (
      live.db
        .query(
          `SELECT path, filename, deleted_at, missing_since FROM asset_locations
            WHERE asset_id = ? ORDER BY ordinal ASC`,
        )
        .all(assetId) as LocationRow[]
    ).filter((e) => e.deleted_at === null && e.missing_since === null);
    expect(liveEntries).toHaveLength(1);
    expect(liveEntries[0]!.path).toBe('new');
    expect(liveEntries[0]!.filename).toBe('IMG.dng');

    // folders.last_scan was stamped.
    const folderRow = live.db.query(`SELECT last_scan FROM folders WHERE id = ?`).get(folderId) as {
      last_scan: string | null;
    };
    expect(folderRow.last_scan).toBe(body.last_scan ?? null);
  });

  it('short-circuits a second scan inside the recent window (last_scan de-bounce)', async () => {
    const root = await makeRoot('scan-debounce-');
    const folderId = insertFolder(live.db, { path: root, slug: 'debounce-test' });

    const first = await scan(folderId);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { ok: boolean; skipped?: string; last_scan?: string };
    expect(firstBody.skipped).toBeUndefined();
    const firstScan = firstBody.last_scan;

    const second = await scan(folderId);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      ok: boolean;
      skipped?: string;
      last_scan?: string;
    };
    expect(secondBody.skipped).toBe('recent');
    // last_scan unchanged — the second call did not re-walk or re-stamp.
    expect(secondBody.last_scan).toBe(firstScan);
  });

  it('returns 404 for an unknown folder id', async () => {
    const res = await scan(new ObjectId().toHexString());
    expect(res.status).toBe(404);
  });
});
