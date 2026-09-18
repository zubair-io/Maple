/**
 * Route-integration test: POST /api/folders/:id/upload
 *
 * Verifies the upload route emits an `asset_changes` row with
 * `kind: "create"` so File Provider clients on the SSE feed see the
 * new asset in their working set immediately, without waiting for the
 * discover watcher to notice the file. This was wired up in
 * `feat(api): emit change event on folder upload` and Copilot asked
 * for explicit coverage.
 *
 * The handler reaches `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the block.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { foldersRoutes } from './folders.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

/** One row of the change feed, as the table stores it. */
interface ChangeRow {
  kind: string;
  asset_id: string | null;
  folder_id: string | null;
  abs_path: string | null;
  relative_path: string | null;
}

/** One asset location, as the table stores it. */
interface LocationRow {
  path: string;
  filename: string;
  library_id: string;
}

describe('POST /api/folders/:id/upload → asset_changes emit', () => {
  let live: LiveTestDatabase;
  let folderId: string;
  let folderPath: string;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    folderPath = await mkdtemp(nodePath.join(tmpdir(), 'maple-upload-test-'));
    folderId = insertFolder(live.db, { path: folderPath, slug: 'upload-test' });
  });

  afterEach(async () => {
    live.close();
    await rm(folderPath, { recursive: true, force: true }).catch(() => {});
  });

  /** Every change row, oldest first. */
  function changes(): ChangeRow[] {
    return live.db
      .query(
        `SELECT kind, asset_id, folder_id, abs_path, relative_path
           FROM asset_changes ORDER BY cursor ASC`,
      )
      .all() as ChangeRow[];
  }

  /** One asset's locations, in array order. */
  function locations(assetId: string): LocationRow[] {
    return live.db
      .query(
        `SELECT path, filename, library_id FROM asset_locations
          WHERE asset_id = ? ORDER BY ordinal ASC`,
      )
      .all(assetId) as LocationRow[];
  }

  it('inserts an asset_changes row with kind=create matching the uploaded asset', async () => {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const fileBytes = new Uint8Array([0x49, 0x49, 0x2a, 0x00]); // TIFF magic; harmless body
    const target = 'uploaded.dng';
    const url = `http://localhost/api/folders/${folderId}/upload`;
    const res = await app.handle(
      new Request(url, {
        method: 'POST',
        headers: {
          'X-Maple-Target-Path': target,
          'Content-Type': 'application/octet-stream',
        },
        body: fileBytes,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { asset_id: string; abs_path: string };
    expect(body.asset_id).toMatch(/^[a-f0-9]{24}$/);
    const expectedAbsPath = nodePath.join(folderPath, target);
    expect(body.abs_path).toBe(expectedAbsPath);

    // The change emit is awaited inside the route (best-effort, but
    // sequential) so by the time the route returns 201 the row should
    // be present. No polling needed.
    const rows = changes();
    expect(rows.length).toBe(1);
    const change = rows[0]!;
    expect(change.kind).toBe('create');
    expect(change.asset_id).toBe(body.asset_id);
    expect(change.folder_id).toBe(folderId);
    expect(change.abs_path).toBe(expectedAbsPath);
    // `relative_path` is computed by `recordAndPublishAssetChange`
    // from `folder.path + abs_path`. For a top-level upload it equals
    // the target path with no leading slash.
    expect(change.relative_path).toBe(target);

    // PR 1 content-addressing invariant: every writer that inserts an asset
    // row writes its canonical location with library-relative path + filename
    // + library_id. The upload route is a writer.
    const entries = locations(body.asset_id);
    expect(entries).toHaveLength(1);
    // Target was "uploaded.dng" at the library root → path === "".
    expect(entries[0]!.path).toBe('');
    expect(entries[0]!.filename).toBe(target);
    expect(entries[0]!.library_id).toBe(folderId);
  });

  it('rejects X-Maple-Target-Path containing backslashes with 400', async () => {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const fileBytes = new Uint8Array([0x49, 0x49, 0x2a, 0x00]);
    // Percent-encode the backslashes so the raw header bytes are still
    // valid HTTP; `decodeURIComponent` will turn them back into `\`
    // and the validator must reject. Without encoding, fetch/Bun may
    // mangle backslashes in the header itself.
    const target = encodeURIComponent('vacation\\2024\\file.dng');
    const url = `http://localhost/api/folders/${folderId}/upload`;
    const res = await app.handle(
      new Request(url, {
        method: 'POST',
        headers: {
          'X-Maple-Target-Path': target,
          'Content-Type': 'application/octet-stream',
        },
        body: fileBytes,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/[Bb]ackslash/);
  });

  it('uploads to a subdirectory record fileinfo[0].path correctly', async () => {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const fileBytes = new Uint8Array([0x49, 0x49, 0x2a, 0x00]);
    const target = 'vacation/2024/uploaded2.dng';
    const url = `http://localhost/api/folders/${folderId}/upload`;
    const res = await app.handle(
      new Request(url, {
        method: 'POST',
        headers: {
          'X-Maple-Target-Path': target,
          'Content-Type': 'application/octet-stream',
        },
        body: fileBytes,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { asset_id: string };

    const entries = locations(body.asset_id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('vacation/2024');
    expect(entries[0]!.filename).toBe('uploaded2.dng');
  });

  // #2535 — a non-media upload (no AssetDoc) used to emit NO change-feed
  // row at all, so `WorkingSetEnumerator.enumerateChanges` on the Apple
  // client had nothing to see, let alone drop. It must now emit a
  // `create` row with `asset_id: null`, resolvable by the client via
  // `(folder_id, relative_path)` instead.
  it('emits an asset_changes row with asset_id=null for a non-media upload', async () => {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const fileBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // not a real PDF, extension is what matters
    const target = 'invoice.pdf';
    const url = `http://localhost/api/folders/${folderId}/upload`;
    const res = await app.handle(
      new Request(url, {
        method: 'POST',
        headers: {
          'X-Maple-Target-Path': target,
          'Content-Type': 'application/octet-stream',
        },
        body: fileBytes,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { abs_path: string; asset_id?: string };
    expect(body.asset_id).toBeUndefined();
    const expectedAbsPath = nodePath.join(folderPath, target);
    expect(body.abs_path).toBe(expectedAbsPath);

    // No catalog row for a non-media file.
    const assetCount = live.db.query(`SELECT COUNT(*) AS n FROM assets`).get() as { n: number };
    expect(assetCount.n).toBe(0);

    const rows = changes();
    expect(rows.length).toBe(1);
    const change = rows[0]!;
    expect(change.kind).toBe('create');
    expect(change.asset_id).toBeNull();
    expect(change.folder_id).toBe(folderId);
    expect(change.abs_path).toBe(expectedAbsPath);
    expect(change.relative_path).toBe(target);
  });
});
