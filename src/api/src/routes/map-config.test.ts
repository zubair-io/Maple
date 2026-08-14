/**
 * routes/map-config.ts integration tests (Map T2, #2826).
 *
 * Uses a real MongoDB on :27077 (throwaway — never touches :27017), mirroring
 * routes/pano.test.ts and routes/network.test.ts.
 *
 * Covers:
 *   - GET /api/map/config returns the default OSM tile URL when unset
 *   - PUT /api/map/config persists an override and the GET reflects it
 *   - PUT with a malformed URL is rejected with 400 + a clear error, and does
 *     NOT persist
 *   - PUT with tile_url: null clears an override back to the default
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, type Db } from 'mongodb';

import { mapConfigRoutes } from './map-config.ts';
import { DEFAULT_MAP_TILE_URL } from '../map/map-config.repo.ts';

// Standalone test DB — never touches the dev DB on :27017.
const MONGO_URL = 'mongodb://localhost:27077';
const TEST_DB = `maple_map_config_test_${process.pid}`;

// getDb() is a singleton pinned to whichever env was live at the first
// connect in the process, and bun test's file order varies — captured and
// restored around a real MongoDB the same way routes/pano.test.ts does.
// Unlike that file, the capture/mutation itself happens INSIDE beforeAll,
// not at module scope: bun evaluates every test file's module body during
// the import/collection phase, before any file's tests actually run, so a
// module-scope `process.env` write here would leak into every other file's
// collection phase and race with their own env, not just this file's tests.
let PRIOR_MONGO_URI: string | undefined;
let PRIOR_MONGO_DB: string | undefined;

const app = new Elysia().use(mapConfigRoutes);

let client: MongoClient | null = null;
let db: Db | null = null;
let mongoReachable = false;

beforeAll(async () => {
  PRIOR_MONGO_URI = process.env.MAPLE_MONGO_URI;
  PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
  process.env.MAPLE_MONGO_URI = MONGO_URL;
  process.env.MAPLE_MONGO_DB = TEST_DB;

  const { closeDb } = await import('../db/client.ts');
  await closeDb();
  try {
    client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 1000 });
    await client.connect();
    db = client.db(TEST_DB);
    mongoReachable = true;
  } catch {
    mongoReachable = false;
  }
});

afterAll(async () => {
  if (db) await db.dropDatabase().catch(() => {});
  await client?.close().catch(() => {});
  if (PRIOR_MONGO_URI === undefined) delete process.env.MAPLE_MONGO_URI;
  else process.env.MAPLE_MONGO_URI = PRIOR_MONGO_URI;
  if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable || !db) return;
  await db.collection('app_settings').deleteMany({});
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

describe('GET /api/map/config', () => {
  it('returns the default OSM tile URL + source "default" when unset', async () => {
    if (!mongoReachable) return;
    const res = await getReq('/api/map/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tile_url: string;
      source: { tile_url: string };
    };
    expect(body.tile_url).toBe(DEFAULT_MAP_TILE_URL);
    expect(body.source.tile_url).toBe('default');
  });
});

describe('PUT /api/map/config', () => {
  it('persists a valid override and round-trips through GET', async () => {
    if (!mongoReachable) return;
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
  });

  it('rejects a malformed URL with 400 and a clear error, and does not persist it', async () => {
    if (!mongoReachable) return;
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
  });

  it('rejects a non-http(s) protocol', async () => {
    if (!mongoReachable) return;
    const res = await putJson('/api/map/config', {
      tile_url: 'ftp://tiles.example.com/{z}/{x}/{y}.png',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Unsupported protocol');
  });

  it('clears a saved override back to the default when tile_url is null', async () => {
    if (!mongoReachable) return;
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
  });
});
