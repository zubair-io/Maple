/**
 * Route-integration tests for the manual override routes:
 *
 *   PUT /api/assets/:id/place
 *   PUT /api/assets/:id/description
 *
 * Pins the HTTP contract (400 on a malformed id, 404 on an unknown asset,
 * 204 + persisted field on success, `null` clears) so the shared
 * asset-resolution prelude in `_shared.ts` can be applied to this file
 * without a silent status/message drift (#1988).
 *
 * Where the two fields land moved with the SQLite cutover (#3787): `place` is a
 * JSON column on `assets`, the description is a column on `asset_detail`, and
 * the recomputed search text is a row in `asset_search` rather than a
 * `search_blob` field on the asset document. The assertions read each where it
 * now lives.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { overrideRoutes } from './overrides.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';
import { newObjectIdHex } from '../../db/object-id.ts';
import { insertDetail } from '../../db/repos/assets.test-helpers.ts';
import {
  registerLibrary,
  searchBlob,
  seedRouteAsset,
} from '../../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

const app = new Elysia({ prefix: '/api/assets' }).use(fakeAuth()).use(overrideRoutes);

function put(id: string, field: 'place' | 'description', body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/assets/${id}/${field}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('PUT /api/assets/:id/{place,description}', () => {
  let live: LiveTestDatabase;
  let assetId: string;

  /** The `place` column, parsed back out of its JSON. */
  function placeOf(id: string): unknown {
    const row = live.db.query(`SELECT place AS v FROM assets WHERE id = ?`).get(id) as {
      v: string | null;
    } | null;
    return row?.v === null || row?.v === undefined ? null : JSON.parse(row.v);
  }

  /** The `asset_detail.description` column, or `null` when there is no row. */
  function descriptionOf(id: string): string | null {
    const row = live.db
      .query(`SELECT description AS v FROM asset_detail WHERE asset_id = ?`)
      .get(id) as {
      v: string | null;
    } | null;
    return row?.v ?? null;
  }

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    const libraryId = registerLibrary(live.db, '/nonexistent/overrides-route-test');
    assetId = seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: 'a.dng',
      size: 1,
      mapleId: `ovr-${newObjectIdHex()}`,
    });
    insertDetail(live.db, assetId, { description: 'from the worker' });
  });

  afterEach(() => {
    live.close();
  });

  it('400s on a malformed asset id with the shared error body', async () => {
    for (const field of ['place', 'description'] as const) {
      const res = await put('not-an-objectid', field, {
        [field === 'place' ? 'place' : 'text']: null,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid asset id' });
    }
  });

  it('404s on an unknown asset id with the shared error body', async () => {
    const unknown = newObjectIdHex();
    const place = await put(unknown, 'place', { place: null });
    expect(place.status).toBe(404);
    expect(await place.json()).toEqual({ error: 'Asset not found' });
    const description = await put(unknown, 'description', { text: null });
    expect(description.status).toBe(404);
    expect(await description.json()).toEqual({ error: 'Asset not found' });
  });

  it('pins a place override (204) and null clears it', async () => {
    const place = { search_blob: 'Reykjavík Iceland', city: 'Reykjavík' };
    const res = await put(assetId, 'place', { place });
    expect(res.status).toBe(204);
    expect(placeOf(assetId)).toEqual(place);
    // The search text is a lowercased, sorted token bag recomputed atomically.
    expect(searchBlob(live.db, assetId)).toContain('reykjavík');

    const cleared = await put(assetId, 'place', { place: null });
    expect(cleared.status).toBe(204);
    expect(placeOf(assetId)).toBeNull();
  });

  it('pins a description override (204) and null clears it', async () => {
    const res = await put(assetId, 'description', { text: 'two gulls on a pier' });
    expect(res.status).toBe(204);
    expect(descriptionOf(assetId)).toBe('two gulls on a pier');
    expect(searchBlob(live.db, assetId)).toContain('gulls');

    const cleared = await put(assetId, 'description', { text: null });
    expect(cleared.status).toBe(204);
    expect(descriptionOf(assetId)).toBeNull();
  });

  it('rejects a body that fails the schema (4xx) without touching the asset', async () => {
    const res = await put(assetId, 'description', { text: 42 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(descriptionOf(assetId)).toBe('from the worker');
  });
});
