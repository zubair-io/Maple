/**
 * `POST /api/people/:id/cover` and `GET /api/people/:id` pagination, against
 * SQLite (#3787). Split out of `people-route.test.ts` to keep each file within
 * the 600-LOC budget.
 *
 * Mounts the route without `requireAuth` (mirrors `tests/enrichment-route.test.ts`).
 * Nothing here reaches the clustering worker, so each test gets its own
 * in-memory database installed as the process-wide handle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { newObjectIdHex } from '../src/db/sqlite/object-id.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { backfillCoverAssets } from '../src/people/clustering-job.ts';
import { peopleRoutes } from '../src/routes/people.ts';
import {
  deletePersonLeavingFaces,
  insertAssetWithFaces,
  type FaceSeed,
} from './helpers/people-fixtures.ts';

let live: LiveTestDatabase;
let libraryId: string;
const app = new Elysia().use(peopleRoutes);

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { path: '/lib', slug: 'lib' });
});

afterEach(() => {
  live.close();
});

function seedFaces(faces: readonly FaceSeed[]): string {
  return insertAssetWithFaces(live.db, libraryId, faces);
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function post(
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

/** `POST /api/people`, returning the new person's id. */
async function createPersonVia(name: string): Promise<string> {
  const created = await post('/api/people', { name });
  expect(created.status).toBe(200);
  return (created.body as { id: string }).id;
}

describe('POST /api/people/:id/cover', () => {
  it('sets cover_asset_id and cover_bbox from the face doc server-side', async () => {
    const personId = await createPersonVia('Cover');
    const bbox = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const asset = seedFaces([{ bbox, personId, confidence: 0.88 }]);
    const r = await post(`/api/people/${personId}/cover`, { asset_id: asset, face_index: 0 });
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
    // Verify via GET /api/people/:id that cover fields updated.
    const detail = await get(`/api/people/${personId}`);
    expect((detail.body as { cover_asset_id: string }).cover_asset_id).toBe(asset);
    expect((detail.body as { cover_bbox: object }).cover_bbox).toEqual(bbox);
  });

  it('400 when face does not belong to this person', async () => {
    const p1Id = await createPersonVia('CoverP1');
    const p2Id = await createPersonVia('CoverP2');
    const asset = seedFaces([{ bbox: { x: 0, y: 0, w: 1, h: 1 }, personId: p2Id }]);
    const r = await post(`/api/people/${p1Id}/cover`, { asset_id: asset, face_index: 0 });
    expect(r.status).toBe(400);
  });

  it('400 when face is hidden', async () => {
    const personId = await createPersonVia('CoverHidden');
    const asset = seedFaces([{ bbox: { x: 0, y: 0, w: 1, h: 1 }, personId, hidden: true }]);
    const r = await post(`/api/people/${personId}/cover`, { asset_id: asset, face_index: 0 });
    expect(r.status).toBe(400);
  });

  it('404 for unknown asset_id', async () => {
    const personId = await createPersonVia('CoverMissing');
    const r = await post(`/api/people/${personId}/cover`, {
      asset_id: newObjectIdHex(),
      face_index: 0,
    });
    expect(r.status).toBe(404);
  });

  it('404 when the person row was deleted after the face was assigned', async () => {
    // The face still points at this person id, but the person row is gone
    // (deleted/merged out-of-band between the face read and the cover write).
    // The update must match zero rows and report not-found, not a phantom 200.
    const personId = await createPersonVia('CoverDeleted');
    const asset = seedFaces([{ bbox: { x: 0, y: 0, w: 1, h: 1 }, personId }]);
    deletePersonLeavingFaces(live.db, personId);
    const r = await post(`/api/people/${personId}/cover`, { asset_id: asset, face_index: 0 });
    expect(r.status).toBe(404);
  });

  it('does not clobber a manually-set cover on backfill', async () => {
    // Set up a person with two faces; manually pin the cover to face 0 (lower
    // confidence). backfillCoverAssets should NOT overwrite a manually-set cover.
    const personId = await createPersonVia('CoverStable');
    const bboxManual = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
    const assetLow = seedFaces([{ bbox: bboxManual, personId, confidence: 0.6 }]);
    // Face with higher confidence on a second asset.
    seedFaces([{ bbox: { x: 0, y: 0, w: 1, h: 1 }, personId, confidence: 0.98 }]);
    // Manually set the low-confidence face as cover.
    const setCover = await post(`/api/people/${personId}/cover`, {
      asset_id: assetLow,
      face_index: 0,
    });
    expect(setCover.status).toBe(200);
    // Run backfill — it should only fill MISSING covers.
    await backfillCoverAssets();
    // The cover should still point at the manually-pinned (lower-conf) asset.
    const detail = await get(`/api/people/${personId}`);
    expect((detail.body as { cover_asset_id: string }).cover_asset_id).toBe(assetLow);
    expect((detail.body as { cover_bbox: object }).cover_bbox).toEqual(bboxManual);
  });
});

describe('GET /api/people/:id pagination', () => {
  it('respects offset and limit query params', async () => {
    const personId = await createPersonVia('PaginatedPerson');
    // Insert 5 faces across 5 separate assets.
    for (let i = 0; i < 5; i++) {
      seedFaces([{ bbox: { x: i * 0.1, y: 0, w: 0.1, h: 0.1 }, personId }]);
    }
    // First page of 3.
    const page1 = await get(`/api/people/${personId}?offset=0&limit=3`);
    expect(page1.status).toBe(200);
    const p1body = page1.body as { faces: unknown[]; offset: number; limit: number };
    expect(p1body.faces).toHaveLength(3);
    expect(p1body.offset).toBe(0);
    expect(p1body.limit).toBe(3);
    // Second page — fewer than limit signals end-of-list.
    const page2 = await get(`/api/people/${personId}?offset=3&limit=3`);
    expect(page2.status).toBe(200);
    expect((page2.body as { faces: unknown[] }).faces).toHaveLength(2);
  });
});
