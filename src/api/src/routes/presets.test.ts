/**
 * Route-integration test: /api/presets CRUD (#1115).
 *
 * Covers the preset list/create/delete cycle, duplicate-name 409s, and the
 * passthrough rule (unknown `fields` keys AND unknown top-level keys from
 * newer schema versions round-trip byte-identically).
 *
 * Requires a running MongoDB (skips gracefully if unreachable) — same
 * pattern as folders.mkdir.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, type Db } from 'mongodb';
import { closeDb } from '../db/client.ts';
import { presetsRoutes } from './presets.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_presets_test_${process.pid}`;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

interface WirePreset {
  id: string;
  schemaVersion: number;
  name: string;
  fields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

describe('/api/presets', () => {
  let mongo: MongoClient | null = null;
  let db: Db | null = null;

  beforeEach(async () => {
    mongo = await tryConnect();
    if (!mongo) return;
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = TEST_DB;
    await closeDb();
    db = mongo.db(TEST_DB);
    await db.dropDatabase();
    // The case-insensitive unique name index the route's 409 path relies on
    // (production builds it in ensureIndexes).
    await db
      .collection('presets')
      .createIndex(
        { name: 1 },
        { unique: true, collation: { locale: 'en', strength: 2 }, name: 'presets_name_unique' },
      );
  });

  afterEach(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (mongo) await mongo.close().catch(() => {});
    await closeDb();
    db = null;
    mongo = null;
  });

  // No explicit `: Elysia` return type — the routed sub-app's generic
  // doesn't satisfy the bare `Elysia` default (same Elysia-generics quirk
  // as `buildApp` in index.ts); inference keeps tsc clean here.
  function app() {
    return new Elysia().use(presetsRoutes);
  }

  function create(body: unknown): Promise<Response> {
    return app().handle(
      new Request('http://localhost/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  function list(): Promise<Response> {
    return app().handle(new Request('http://localhost/api/presets'));
  }

  function del(id: string): Promise<Response> {
    return app().handle(new Request(`http://localhost/api/presets/${id}`, { method: 'DELETE' }));
  }

  it('creates a preset and lists it back', async () => {
    if (!mongo) {
      console.log('[presets.test] MongoDB unreachable — skipping');
      return;
    }
    const res = await create({
      schemaVersion: 1,
      name: 'My Sunset',
      fields: { contrast: -25, saturation: 15, profile: 'Neutral' },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as WirePreset;
    expect(created.id).toMatch(/^[0-9a-f]{24}$/);
    expect(created.schemaVersion).toBe(1);
    expect(created.name).toBe('My Sunset');
    expect(created.fields).toEqual({ contrast: -25, saturation: 15, profile: 'Neutral' });

    const listed = (await (await list()).json()) as { presets: WirePreset[] };
    expect(listed.presets).toHaveLength(1);
    expect(listed.presets[0].id).toBe(created.id);
    expect(listed.presets[0].fields).toEqual(created.fields);
  });

  it('sorts the list by name (case-insensitive)', async () => {
    if (!mongo) return;
    await create({ schemaVersion: 1, name: 'zebra', fields: {} });
    await create({ schemaVersion: 1, name: 'Alpha', fields: {} });
    await create({ schemaVersion: 1, name: 'mango', fields: {} });
    const listed = (await (await list()).json()) as { presets: WirePreset[] };
    expect(listed.presets.map((p) => p.name)).toEqual(['Alpha', 'mango', 'zebra']);
  });

  it('preserves unknown fields AND unknown top-level keys (passthrough)', async () => {
    if (!mongo) return;
    const res = await create({
      schemaVersion: 3,
      name: 'From The Future',
      fields: { contrast: 10, future_curve_strength: 0.5, future_mode: 'Soft' },
      futureTopLevel: { anything: ['goes', 1] },
    });
    expect(res.status).toBe(201);
    const listed = (await (await list()).json()) as { presets: WirePreset[] };
    expect(listed.presets).toHaveLength(1);
    const row = listed.presets[0];
    expect(row.schemaVersion).toBe(3);
    expect(row.fields).toEqual({
      contrast: 10,
      future_curve_strength: 0.5,
      future_mode: 'Soft',
    });
    expect(row.futureTopLevel).toEqual({ anything: ['goes', 1] });
  });

  it('rejects duplicate names with 409 (case-insensitive)', async () => {
    if (!mongo) return;
    const first = await create({ schemaVersion: 1, name: 'Flat Light', fields: {} });
    expect(first.status).toBe(201);
    const dupe = await create({ schemaVersion: 1, name: 'flat light', fields: {} });
    expect(dupe.status).toBe(409);
    const body = (await dupe.json()) as { error: string };
    expect(body.error).toContain('already exists');
  });

  it('rejects invalid documents with 400', async () => {
    if (!mongo) return;
    // Out-of-range known field.
    expect((await create({ schemaVersion: 1, name: 'x', fields: { contrast: 500 } })).status).toBe(
      400,
    );
    // Wrong-typed known field.
    expect(
      (await create({ schemaVersion: 1, name: 'x', fields: { contrast: 'red' } })).status,
    ).toBe(400);
    // Non-scalar unknown field.
    expect(
      (await create({ schemaVersion: 1, name: 'x', fields: { future: { a: 1 } } })).status,
    ).toBe(400);
    // Whitespace-only name.
    expect((await create({ schemaVersion: 1, name: '   ', fields: {} })).status).toBe(400);
    // Bad schema version.
    expect((await create({ schemaVersion: 0, name: 'x', fields: {} })).status).toBe(400);
    // Nothing got stored.
    const listed = (await (await list()).json()) as { presets: WirePreset[] };
    expect(listed.presets).toHaveLength(0);
  });

  it('deletes a preset (and 404s on a second delete)', async () => {
    if (!mongo) return;
    const created = (await (
      await create({ schemaVersion: 1, name: 'Doomed', fields: { exposure: 1 } })
    ).json()) as WirePreset;
    const res = await del(created.id);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    const again = await del(created.id);
    expect(again.status).toBe(404);
    const listed = (await (await list()).json()) as { presets: WirePreset[] };
    expect(listed.presets).toHaveLength(0);
  });

  it('rejects malformed preset ids with 400', async () => {
    if (!mongo) return;
    expect((await del('not-an-id')).status).toBe(400);
  });
});
