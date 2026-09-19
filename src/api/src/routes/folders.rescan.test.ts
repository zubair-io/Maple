/**
 * Route-integration test: POST /api/folders/:id/rescan
 *
 * The button an operator presses when a library has been reorganised behind
 * the server's back. It re-arms every stage on every asset in that library —
 * version back to 0, dead flag lifted, attempt count and last error cleared —
 * and leaves assets in other libraries alone.
 *
 * This drives the real handler. The previous version of this file rebuilt the
 * handler's own update payload inside the test and asserted against the
 * database directly, which proved that MongoDB applies a `$set` rather than
 * that the route does the right thing.
 *
 * The handler reaches `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the block.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { ALL_STAGE_NAMES } from '../workers/stages/manifest.ts';
import { foldersRoutes } from './folders.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

interface StageRow {
  version: number;
  dead: number;
  attempts: number;
  last_error: string | null;
}

describe('POST /api/folders/:id/rescan', () => {
  let live: LiveTestDatabase;
  let roots: string[] = [];

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    roots = [];
  });

  afterEach(async () => {
    live.close();
    for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /** A real directory, so the handler's filesystem re-walk has something to open. */
  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(nodePath.join(tmpdir(), 'maple-rescan-test-'));
    roots.push(root);
    return root;
  }

  /** An asset in `libraryId`, with every stage already processed at version 1. */
  function seedProcessedAsset(libraryId: string, filename: string, dir = ''): string {
    const assetId = insertAsset(live.db);
    insertLocation(live.db, { assetId, libraryId, path: dir, filename });
    for (const stage of ALL_STAGE_NAMES) {
      run(
        live.db,
        `INSERT INTO stage_state (asset_id, stage, version, attempts, last_error, dead)
         VALUES (?, ?, 1, 3, 'boom', 1)`,
        assetId,
        stage,
      );
    }
    return assetId;
  }

  function stageRow(assetId: string, stage: string): StageRow {
    return live.db
      .query(
        `SELECT version, dead, attempts, last_error FROM stage_state
               WHERE asset_id = ? AND stage = ?`,
      )
      .get(assetId, stage) as StageRow;
  }

  function rescan(folderId: string): Promise<Response> {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    return app.handle(
      new Request(`http://localhost/api/folders/${folderId}/rescan`, { method: 'POST' }),
    );
  }

  it('zeroes every stage on every asset in the library and reports the count', async () => {
    const root = await makeRoot();
    const folderId = insertFolder(live.db, { path: root, slug: 'rescan-target' });
    const otherId = insertFolder(live.db, { path: await makeRoot(), slug: 'rescan-other' });

    const inLibrary = [
      seedProcessedAsset(folderId, 'img1.dng'),
      seedProcessedAsset(folderId, 'img2.dng', 'sub'),
    ];
    const outside = seedProcessedAsset(otherId, 'img3.dng');

    const res = await rescan(folderId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reset: number; last_scan: string };
    expect(body.ok).toBe(true);
    // Assets, not stage rows — that is the number the operator reads.
    expect(body.reset).toBe(2);
    expect(body.last_scan).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    for (const assetId of inLibrary) {
      for (const stage of ALL_STAGE_NAMES) {
        const row = stageRow(assetId, stage);
        expect(row.version).toBe(0);
        expect(row.dead).toBe(0);
        expect(row.attempts).toBe(0);
        expect(row.last_error).toBeNull();
      }
    }

    // The other library's asset is untouched.
    const untouched = stageRow(outside, 'exif');
    expect(untouched.version).toBe(1);
    expect(untouched.dead).toBe(1);
    expect(untouched.attempts).toBe(3);
  });

  it('stamps last_scan on the folder row', async () => {
    const root = await makeRoot();
    const folderId = insertFolder(live.db, { path: root, slug: 'rescan-stamp' });
    expect(
      (
        live.db.query(`SELECT last_scan FROM folders WHERE id = ?`).get(folderId) as {
          last_scan: string | null;
        }
      ).last_scan,
    ).toBeNull();

    const body = (await (await rescan(folderId)).json()) as { last_scan: string };
    const stored = live.db.query(`SELECT last_scan FROM folders WHERE id = ?`).get(folderId) as {
      last_scan: string | null;
    };
    expect(stored.last_scan).toBe(body.last_scan);
  });

  it('returns 404 when the folder does not exist', async () => {
    const res = await rescan(new ObjectId().toHexString());
    expect(res.status).toBe(404);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: false });
  });

  it('returns 400 when the folder id is invalid', async () => {
    const res = await rescan('not-an-object-id');
    expect(res.status).toBe(400);
  });

  it('resets nothing when the library owns no assets', async () => {
    const folderId = insertFolder(live.db, { path: await makeRoot(), slug: 'rescan-empty' });
    const otherId = insertFolder(live.db, { path: await makeRoot(), slug: 'rescan-empty-other' });
    const outside = seedProcessedAsset(otherId, 'img1.dng', '2024');

    const body = (await (await rescan(folderId)).json()) as { reset: number };
    expect(body.reset).toBe(0);
    expect(stageRow(outside, 'exif').version).toBe(1);
  });
});
