/**
 * POST /api/assets/:id/restore — move a trashed file back and revive its row.
 *
 * Drives the composed app, so the database has to be the process-wide one:
 * `createLiveTestDatabase()` installs a private in-memory SQLite database for
 * the file and puts the previous handle back on the way out (#3787). Real
 * files in a private temp directory; no external service, so nothing to skip
 * on.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { signAccessToken } from '../src/auth/tokens.ts';
import { newObjectIdHex } from '../src/db/object-id.ts';
import { setMeilisearchClientForTests } from '../src/enrichment/meilisearch-client.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { insertDetail } from '../src/db/repos/assets.test-helpers.ts';
import { withTestEnv } from '../src/test-support/env.test-helpers.ts';
import {
  assetRow,
  capturingMeili,
  failingMeili,
  locationRows,
  primaryAbsPath,
  registerLibrary,
  seedRouteAsset,
} from './helpers/assets-route-fixtures.ts';

// JWT bootstrap MUST run before any module that touches `requireAuth`, which
// rules out `withTestEnv` here: its write happens in `beforeAll`, and the
// token below is signed while this module body runs.
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const BEARER =
  'Bearer ' +
  (await signAccessToken(
    {
      file_access: true,
      sub: '00000000000000000000000a',
      email: 'tester@maple.local',
      role: 'owner',
    },
    process.env.MAPLE_JWT_SECRET,
  ));

const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-fp3-restore-')));
withTestEnv('MAPLE_ROOTS', ROOT);

/** Where a trashed `2024/<name>` copy lives. */
const TRASH_REL = path.join('.maple', 'trash', '2024');

let live: LiveTestDatabase;
let folderId: string;

/**
 * An asset in the state the trash route leaves behind: bytes under
 * `.maple/trash/2024/`, the catalog location pointing there, `deleted_at`
 * stamped and `original_path` remembering where it came from.
 */
async function trashedAsset(
  filename: string,
  opts?: { mapleId?: string; description?: string },
): Promise<{ assetId: string; originalPath: string; trashPath: string }> {
  const originalPath = path.join(ROOT, '2024', filename);
  const trashPath = path.join(ROOT, TRASH_REL, filename);
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.mkdir(path.dirname(trashPath), { recursive: true });
  await fs.writeFile(trashPath, 'raw');
  const assetId = seedRouteAsset(live.db, {
    libraryId: folderId,
    path: '.maple/trash/2024',
    filename,
    deletedAt: new Date().toISOString(),
    originalPath,
    mapleId: opts?.mapleId ?? null,
  });
  if (opts?.description !== undefined) {
    insertDetail(live.db, assetId, { description: opts.description });
  }
  return { assetId, originalPath, trashPath };
}

function restoreReq(assetId: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost/api/assets/${assetId}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: BEARER },
    body: JSON.stringify(body),
  });
}

describe('POST /api/assets/:id/restore', () => {
  beforeAll(async () => {
    live = await createLiveTestDatabase();
    folderId = registerLibrary(live.db, ROOT, 'restore-suite');
  });

  afterAll(async () => {
    live.close();
    setMeilisearchClientForTests(null);
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    setMeilisearchClientForTests(null);
  });

  test('restores to original_path; clears deleted_at + original_path', async () => {
    const { app } = await import('../src/index.ts');
    const { assetId, originalPath, trashPath } = await trashedAsset('IMG_R1.ARW');

    const res = await app.handle(restoreReq(assetId, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { abs_path: string };
    expect(body.abs_path).toBe(originalPath);

    await fs.stat(originalPath);
    await expect(fs.stat(trashPath)).rejects.toThrow();
    const row = assetRow(live.db, assetId);
    expect(row!.deleted_at).toBeNull();
    expect(row!.original_path).toBeNull();
    expect(primaryAbsPath(live.db, ROOT, assetId)).toBe(originalPath);
  });

  test('restores to body-supplied target_relative_path', async () => {
    const { app } = await import('../src/index.ts');
    const { assetId } = await trashedAsset('IMG_R2.ARW');
    const target = 'elsewhere/IMG_R2.ARW';
    const res = await app.handle(restoreReq(assetId, { target_relative_path: target }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { abs_path: string };
    expect(body.abs_path).toBe(path.join(ROOT, target));
    await fs.stat(body.abs_path);
  });

  test('.restored suffix appended on collision', async () => {
    const { app } = await import('../src/index.ts');
    const { assetId, originalPath } = await trashedAsset('IMG_R3.ARW');
    // Create a new file at the original path so restore must rename.
    await fs.writeFile(originalPath, 'occupier');

    const res = await app.handle(restoreReq(assetId, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      abs_path: string;
      filename: string;
      size: number;
      mtime: string;
    };
    expect(body.abs_path).toBe(path.join(path.dirname(originalPath), 'IMG_R3.restored.ARW'));
    expect(await fs.readFile(originalPath, 'utf-8')).toBe('occupier');
    expect(await fs.readFile(body.abs_path, 'utf-8')).toBe('raw');
    // Response must carry the freshly-stat'd metadata so the File
    // Provider extension doesn't need to stat the server-side path.
    expect(body.filename).toBe('IMG_R3.restored.ARW');
    expect(body.size).toBe(3); // "raw"
    // Wire contract: `mtime` is an ISO-8601 string so the Swift
    // `RestoreResponse.mtime: Date` decoder (RemoteCatalog.swift) accepts
    // it. The DB column stays epoch-ms — see the assertion below.
    expect(typeof body.mtime).toBe('string');
    expect(body.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isFinite(Date.parse(body.mtime))).toBe(true);
    // The location must carry the renamed filename so future re-uploads at
    // the OLD basename don't collide on the content-addressed path.
    expect(locationRows(live.db, assetId)[0]!.filename).toBe('IMG_R3.restored.ARW');
    const row = assetRow(live.db, assetId);
    expect(row!.size).toBe(3);
    // The column stays epoch-ms (number) — only the wire response is ISO.
    expect(typeof row!.mtime).toBe('number');
    expect(Number.isFinite(row!.mtime)).toBe(true);
  });

  // Regression for #166: a restored asset's mtime must persist as a
  // number so the assets-list serialiser (`Math.floor(r.mtime / 1000)`)
  // doesn't yield NaN, AND must surface as an ISO-8601 string on the
  // restore wire so the Swift `RestoreResponse.mtime: Date` decoder
  // accepts it. Previously the restore handler wrote an ISO string into
  // the catalog, which broke the Swift client's contentModificationDate
  // downstream via GET /api/assets.
  test('restored mtime is ISO on wire, number in DB, finite seconds via GET /api/assets', async () => {
    const { app } = await import('../src/index.ts');
    const { assetId } = await trashedAsset('IMG_R166.ARW');

    const res = await app.handle(restoreReq(assetId, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mtime: unknown };
    // Wire: ISO-8601 string (Swift decoder expects Date).
    expect(typeof body.mtime).toBe('string');
    expect(Number.isFinite(Date.parse(body.mtime as string))).toBe(true);

    // Column: epoch-ms number.
    const row = assetRow(live.db, assetId);
    expect(typeof row!.mtime).toBe('number');
    expect(Number.isFinite(row!.mtime)).toBe(true);

    // Round-trip through GET /api/assets: must yield a finite integer in
    // seconds for the restored asset (not NaN).
    const listRes = await app.handle(
      new Request(`http://localhost/api/assets?limit=20000`, {
        headers: { Authorization: BEARER },
      }),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { assets: Array<{ id: string; mtime: number }> };
    const restored = listBody.assets.find((a) => a.id === assetId);
    expect(restored).toBeTruthy();
    expect(typeof restored!.mtime).toBe('number');
    expect(Number.isNaN(restored!.mtime)).toBe(false);
    expect(Number.isFinite(restored!.mtime)).toBe(true);
  });

  // Cat A3: cross-library restore must be rejected. The server's file
  // move uses the asset's ORIGINAL folder root; restoring into a
  // different library would silently land in the wrong place.
  test("400 when target_folder_id != asset's folder_id (cross-library guard)", async () => {
    const { app } = await import('../src/index.ts');
    const { assetId } = await trashedAsset('IMG_XLIB.ARW');
    const res = await app.handle(restoreReq(assetId, { target_folder_id: newObjectIdHex() }));
    expect(res.status).toBe(400);
    // Row unchanged.
    expect(assetRow(live.db, assetId)!.deleted_at).toBeTruthy();
  });

  test("200 when target_folder_id matches asset's folder_id", async () => {
    const { app } = await import('../src/index.ts');
    const { assetId } = await trashedAsset('IMG_XLIB_OK.ARW');
    const res = await app.handle(restoreReq(assetId, { target_folder_id: folderId }));
    expect(res.status).toBe(200);
  });

  // Cat A4-restore: watcher race — if the discover watcher beat the
  // route handler and inserted a fresh asset at the restored address, the
  // repoint would collide with `asset_locations_lib_path_name`. The
  // restore drops the watcher's transient row inside the same
  // transaction.
  test('restore wins over a watcher-inserted ghost row at the same address', async () => {
    const { app } = await import('../src/index.ts');
    const { assetId, originalPath } = await trashedAsset('IMG_WATCHER.ARW');
    const ghostId = seedRouteAsset(live.db, {
      libraryId: folderId,
      path: '2024',
      filename: 'IMG_WATCHER.ARW',
      size: 99,
    });

    const res = await app.handle(restoreReq(assetId, {}));
    expect(res.status).toBe(200);
    // Ghost is gone, original asset row is now live at the restored path.
    expect(assetRow(live.db, ghostId)).toBeNull();
    expect(assetRow(live.db, assetId)!.deleted_at).toBeNull();
    expect(primaryAbsPath(live.db, ROOT, assetId)).toBe(originalPath);
  });

  test('409 when asset is not trashed', async () => {
    const { app } = await import('../src/index.ts');
    const assetId = seedRouteAsset(live.db, {
      libraryId: folderId,
      path: '',
      filename: 'live.ARW',
      size: 0,
      mtimeMs: 0,
    });
    const res = await app.handle(restoreReq(assetId, {}));
    expect(res.status).toBe(409);
  });

  test('restore re-indexes the asset in Meilisearch with deletedAt=null', async () => {
    const meili = capturingMeili();
    setMeilisearchClientForTests(meili);
    const { app } = await import('../src/index.ts');
    const mapleId = 'feedfacefeedface';
    const { assetId, originalPath } = await trashedAsset('IMG_RM1.ARW', {
      mapleId,
      description: 'a sunset over the river',
    });

    const res = await app.handle(restoreReq(assetId, {}));
    expect(res.status).toBe(200);

    expect(meili.upserts.length).toBe(1);
    const upserted = meili.upserts[0]!;
    expect(upserted.id).toBe(mapleId);
    expect(upserted.deletedAt).toBeNull();
    expect(upserted.folderId).toBe(folderId);
    expect(upserted.description).toBe('a sunset over the river');
    // searchBlob is a sorted, deduped token bag — the description tokens
    // are present in some order.
    expect(upserted.searchBlob).toContain('sunset');
    expect(upserted.searchBlob).toContain('river');

    // File restored regardless of Meili side-effects.
    await fs.stat(originalPath);
  });

  test('restore skips Meilisearch when maple_id is absent (legacy row)', async () => {
    const meili = capturingMeili();
    setMeilisearchClientForTests(meili);
    const { app } = await import('../src/index.ts');
    const { assetId } = await trashedAsset('IMG_RM2.ARW');

    const res = await app.handle(restoreReq(assetId, {}));
    expect(res.status).toBe(200);
    expect(meili.upserts).toEqual([]);
  });

  test('restore returns 200 even when Meilisearch throws', async () => {
    setMeilisearchClientForTests(failingMeili(['upsert']));
    const { app } = await import('../src/index.ts');
    const { assetId, originalPath } = await trashedAsset('IMG_RM3.ARW', { mapleId: 'xyz789' });

    const res = await app.handle(restoreReq(assetId, {}));
    expect(res.status).toBe(200);
    // Catalog restored and file moved despite the Meilisearch failure.
    const row = assetRow(live.db, assetId);
    expect(row!.deleted_at).toBeNull();
    expect(row!.original_path).toBeNull();
    expect(primaryAbsPath(live.db, ROOT, assetId)).toBe(originalPath);
    await fs.stat(originalPath);
  });

  test('404 on unknown asset id', async () => {
    const { app } = await import('../src/index.ts');
    const res = await app.handle(restoreReq(newObjectIdHex(), {}));
    expect(res.status).toBe(404);
  });
});
