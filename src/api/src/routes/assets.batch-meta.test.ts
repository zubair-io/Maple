/**
 * Route-integration test: POST /api/assets/batch-meta (#2995).
 *
 * The File Provider's change-feed resolution used to make one
 * GET /api/assets/:id round trip per change row; this endpoint resolves a
 * whole page of ids in one request. Contract under test:
 *   - found ids come back with the same DTO shape as GET /:id
 *   - unknown (but valid) ids are silently absent from `assets`
 *   - malformed body / invalid id / over-500 ids → 400
 *
 * Seeds SQLite through the shared route fixtures (#3787) — an asset now needs a
 * real `folders` row behind it, because `asset_locations.library_id` is a
 * foreign key where the Mongo `fileinfo[].library_id` was a bare id.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { assetsRoutes } from './assets.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { newObjectIdHex } from '../db/object-id.ts';
import { registerLibrary, seedRouteAsset } from '../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = registerLibrary(live.db, '/libraries/batch-meta');
});

afterEach(() => {
  live.close();
});

function seedAsset(filename: string): string {
  return seedRouteAsset(live.db, { libraryId, path: '2026', filename, size: 1024 });
}

function post(app: Pick<Elysia, 'handle'>, body: unknown): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/assets/batch-meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/assets/batch-meta', () => {
  it('resolves found ids and omits unknown ids', async () => {
    const a = seedAsset('IMG_1.dng');
    const b = seedAsset('IMG_2.dng');
    const missing = newObjectIdHex();
    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);

    const res = await post(app, { ids: [a, b, missing] });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { assets: { id: string; filename: string }[] };
    const byId = new Map(body.assets.map((x) => [x.id, x]));
    expect(byId.size).toBe(2);
    expect(byId.get(a)?.filename).toBe('IMG_1.dng');
    expect(byId.get(b)?.filename).toBe('IMG_2.dng');
    expect(byId.has(missing)).toBe(false);
  });

  it('returns an empty list for an empty ids array', async () => {
    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);
    const res = await post(app, { ids: [] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { assets: unknown[] }).assets).toEqual([]);
  });

  it('400s on a malformed body, an invalid id, and over 500 ids', async () => {
    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);

    expect((await post(app, { nope: true })).status).toBe(400);
    expect((await post(app, { ids: ['not-hex'] })).status).toBe(400);
    const tooMany = Array.from({ length: 501 }, () => newObjectIdHex());
    expect((await post(app, { ids: tooMany })).status).toBe(400);
  });
});
