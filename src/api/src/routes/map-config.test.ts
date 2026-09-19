/**
 * routes/map-config.ts integration tests (Map T2, #2826).
 *
 * Drives the mounted route against SQLite (#3787). The tile-source setting is
 * one document in `app_settings`, read and written through
 * `readAppSettings` / `patchAppSettings`, so the assertions go through those
 * rather than through a collection handle.
 *
 * `createLiveTestDatabase()` installs a private in-memory database as the
 * process-wide handle for the test that opened it, which is what the route's
 * `sqliteDb()` (no override) resolves to. A fresh database per test replaces
 * the `deleteMany({})` the Mongo version needed to get back to "no operator has
 * touched this yet", and nothing skips: there is no external service to be
 * unreachable, so a pass means the assertions ran.
 *
 * Covers:
 *   - GET /api/map/config returns the default OSM tile URL when unset
 *   - PUT /api/map/config persists an override and the GET reflects it
 *   - PUT with a malformed URL is rejected with 400 + a clear error, and does
 *     NOT persist
 *   - PUT with tile_url: null clears an override back to the default
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';

import { mapConfigRoutes } from './map-config.ts';
import { DEFAULT_MAP_TILE_URL } from '../map/map-config.repo.ts';
import { readAppSettings } from '../db/sqlite/repos/app-settings.repo.ts';
import type { MapConfig } from '../map/map-config.repo.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

const app = new Elysia().use(mapConfigRoutes);

let live: LiveTestDatabase;

beforeEach(async () => {
  live = await createLiveTestDatabase();
});

afterEach(() => {
  live.close();
});

async function getReq(url: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${url}`));
}

async function putJson(url: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** The stored document, as the settings repository hands it back. */
async function storedConfig(): Promise<MapConfig | null> {
  const doc = await readAppSettings<{ config: MapConfig }>('map');
  return doc?.config ?? null;
}

describe('GET /api/map/config', () => {
  it('returns the default OSM tile URL + source "default" when unset', async () => {
    const res = await getReq('/api/map/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tile_url: string;
      source: { tile_url: string };
    };
    expect(body.tile_url).toBe(DEFAULT_MAP_TILE_URL);
    expect(body.source.tile_url).toBe('default');
    // Nothing was written just by reading.
    expect(await storedConfig()).toBeNull();
  });
});

describe('PUT /api/map/config', () => {
  it('persists a valid override and round-trips through GET', async () => {
    const override = 'https://tiles.example.com/{z}/{x}/{y}.png';
    const putRes = await putJson('/api/map/config', { tile_url: override });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { ok: boolean; tile_url: string };
    expect(putBody.ok).toBe(true);
    expect(putBody.tile_url).toBe(override);

    const getRes = await getReq('/api/map/config');
    const getBody = (await getRes.json()) as {
      tile_url: string;
      source: { tile_url: string };
    };
    expect(getBody.tile_url).toBe(override);
    expect(getBody.source.tile_url).toBe('db');

    // And it really landed in the settings document, not just in a cache.
    expect((await storedConfig())?.tile_url).toBe(override);
  });

  it('rejects a malformed URL with 400 and a clear error, and does not persist it', async () => {
    const res = await putJson('/api/map/config', { tile_url: 'not a url' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Not a valid URL');

    const getRes = await getReq('/api/map/config');
    const getBody = (await getRes.json()) as {
      tile_url: string;
      source: { tile_url: string };
    };
    expect(getBody.tile_url).toBe(DEFAULT_MAP_TILE_URL);
    expect(getBody.source.tile_url).toBe('default');
    expect(await storedConfig()).toBeNull();
  });

  it('rejects a non-http(s) protocol', async () => {
    const res = await putJson('/api/map/config', {
      tile_url: 'ftp://tiles.example.com/{z}/{x}/{y}.png',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Unsupported protocol');
    expect(await storedConfig()).toBeNull();
  });

  it('clears a saved override back to the default when tile_url is null', async () => {
    await putJson('/api/map/config', {
      tile_url: 'https://tiles.example.com/{z}/{x}/{y}.png',
    });
    const clearRes = await putJson('/api/map/config', { tile_url: null });
    expect(clearRes.status).toBe(200);
    const clearBody = (await clearRes.json()) as {
      tile_url: string;
      source: { tile_url: string };
    };
    expect(clearBody.tile_url).toBe(DEFAULT_MAP_TILE_URL);
    expect(clearBody.source.tile_url).toBe('default');
    // The document survives the clear — only the override is gone.
    expect((await storedConfig())?.tile_url).toBeNull();
  });
});
