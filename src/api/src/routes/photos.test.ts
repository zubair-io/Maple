/**
 * Route-integration test: the hidden-asset review list and its
 * acknowledgement.
 *
 *   GET  /api/photos/hidden           — every hidden asset, newest first
 *   GET  /api/photos/hidden?onlyNew=1 — unacknowledged AI-driven hides only
 *   POST /api/assets/:id/hidden-ack   — acknowledge one AI-driven hide
 *
 * The handlers reach `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the block.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { photosRoutes } from './photos.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';

const LIBRARY_ID = '111111111111111111111111';

interface HiddenDto {
  id: string;
  hidden?: boolean;
  hidden_reason?: string | null;
  hidden_ack?: boolean;
  address: string | null;
}

describe('/api/photos/hidden & /api/assets/:id/hidden-ack', () => {
  let live: LiveTestDatabase;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    // The library row has to exist for the asset's location foreign key, and
    // its slug is what turns that location into a wire address. The roots
    // cache is process-wide, so it is dropped on both sides of the test rather
    // than stuffed with a fixture map.
    run(
      live.db,
      `INSERT INTO folders (id, path, slug, label, file_count, created_at)
       VALUES (?, '/tmp/lib-1', 'lib-1', 'Library 1', 0, ?)`,
      LIBRARY_ID,
      new Date().toISOString(),
    );
    invalidateLibraryRoots();
  });

  afterEach(() => {
    live.close();
    invalidateLibraryRoots();
  });

  function app() {
    return new Elysia().use(photosRoutes);
  }

  /** A hidden asset with one live location, and the hidden columns set. */
  function seedHidden(
    filename: string,
    reason: 'manual' | 'nudity' | 'nudity-burst',
    ack?: boolean,
  ): string {
    const assetId = insertAsset(live.db);
    insertLocation(live.db, { assetId, libraryId: LIBRARY_ID, path: 'sub', filename });
    run(
      live.db,
      `UPDATE assets SET hidden = 1, hidden_reason = ?, hidden_ack = ? WHERE id = ?`,
      reason,
      ack === true ? 1 : 0,
      assetId,
    );
    return assetId;
  }

  function hiddenAck(assetId: string): number {
    return (
      live.db.query(`SELECT hidden_ack FROM assets WHERE id = ?`).get(assetId) as {
        hidden_ack: number;
      }
    ).hidden_ack;
  }

  it('GET /api/photos/hidden returns list of hidden assets', async () => {
    const assetId = seedHidden('img.dng', 'manual');

    const res = await app().handle(new Request('http://localhost/api/photos/hidden'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as HiddenDto[];
    expect(body).toHaveLength(1);
    expect(body[0]!.id).toBe(assetId);
    expect(body[0]!.hidden).toBe(true);
    expect(body[0]!.hidden_reason).toBe('manual');
    // The slug:relPath address the batch-metadata route resolves.
    expect(body[0]!.address).toBe('lib-1:sub/img.dng');
  });

  it('GET /api/photos/hidden?onlyNew=true filters correctly', async () => {
    // manual hide: not returned by onlyNew=true
    seedHidden('img1.dng', 'manual');
    // nudity hide, ack=true: not returned
    seedHidden('img2.dng', 'nudity', true);
    // nudity hide, ack=false: returned!
    const targetId = seedHidden('img3.dng', 'nudity');

    const res = await app().handle(new Request('http://localhost/api/photos/hidden?onlyNew=true'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as HiddenDto[];
    expect(body).toHaveLength(1);
    expect(body[0]!.id).toBe(targetId);
  });

  it('GET /api/photos/hidden returns the newest hide first', async () => {
    const older = seedHidden('old.dng', 'nudity');
    const newer = seedHidden('new.dng', 'nudity');
    // Ids are mint-ordered, so "newest first" is descending id.
    expect(newer > older).toBe(true);

    const body = (await (
      await app().handle(new Request('http://localhost/api/photos/hidden'))
    ).json()) as HiddenDto[];
    expect(body.map((row) => row.id)).toEqual([newer, older]);
  });

  it('POST /api/assets/:id/hidden-ack acknowledges the alert', async () => {
    const targetId = seedHidden('img3.dng', 'nudity');

    const res = await app().handle(
      new Request(`http://localhost/api/assets/${targetId}/hidden-ack`, { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });

    expect(hiddenAck(targetId)).toBe(1);
  });

  it('POST /api/assets/:id/hidden-ack does not touch a manually-hidden asset', async () => {
    const targetId = seedHidden('img4.dng', 'manual');

    const res = await app().handle(
      new Request(`http://localhost/api/assets/${targetId}/hidden-ack`, { method: 'POST' }),
    );
    // hidden_ack is meaningless for a manual hide — the route scopes its
    // update to AI-driven hides only, so a manual hide's id resolves as
    // "not an AI-driven hide" rather than being silently stamped anyway.
    expect(res.status).toBe(404);

    expect(hiddenAck(targetId)).toBe(0);
  });

  it('POST /api/assets/:id/hidden-ack rejects a malformed id with 400', async () => {
    const res = await app().handle(
      new Request('http://localhost/api/assets/not-an-id/hidden-ack', { method: 'POST' }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /api/assets/:id/hidden-ack 404s for an unknown asset', async () => {
    const res = await app().handle(
      new Request(`http://localhost/api/assets/${new ObjectId().toHexString()}/hidden-ack`, {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(404);
  });
});
