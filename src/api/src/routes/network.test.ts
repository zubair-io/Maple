/**
 * Route-integration test: GET/PUT /api/network/*
 *
 * Covers: the public report route requires no Authorization header (the
 * regression that matters most, since this endpoint is deliberately mounted
 * outside the `requireAuth` sub-app), reflects a saved override, and reports
 * `available: false` when disabled. The config CRUD route validates input
 * and round-trips overrides.
 *
 * Requires a running MongoDB (skips gracefully if unreachable), mirroring
 * `backup-exists.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, type Db } from 'mongodb';
import { closeDb } from '../db/client.ts';
import { networkPublicRoutes, networkSettingsRoutes } from './network.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_network_test_${process.pid}`;

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
    } catch {}
    return null;
  }
}

describe('/api/network/*', () => {
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
  });

  afterEach(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (mongo) await mongo.close().catch(() => {});
    await closeDb();
    db = null;
    mongo = null;
  });

  function publicApp() {
    return new Elysia().use(networkPublicRoutes);
  }
  function settingsApp() {
    return new Elysia().use(networkSettingsRoutes);
  }

  async function getLocalAddress(): Promise<Response> {
    return publicApp().handle(new Request('http://localhost/api/network/local-address'));
  }

  async function putConfig(body: unknown): Promise<Response> {
    return settingsApp().handle(
      new Request('http://localhost/api/network/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  it('GET /api/network/local-address requires no Authorization header', async () => {
    if (!mongo) {
      console.log('[network.test] MongoDB unreachable — skipping');
      return;
    }
    const res = await getLocalAddress();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean };
    expect(typeof body.available).toBe('boolean');
  });

  it('reflects a saved local_ip_override', async () => {
    if (!mongo || !db) return;
    await db
      .collection('app_settings')
      .updateOne(
        { _id: 'network' },
        { $set: { config: { local_ip_override: '10.0.0.5', local_port_override: 4000 } } },
        { upsert: true },
      );
    const res = await getLocalAddress();
    const body = (await res.json()) as { available: boolean; ip?: string; port?: number };
    expect(body).toEqual({ available: true, ip: '10.0.0.5', port: 4000, scheme: 'http' });
  });

  it('reports available: false when disabled', async () => {
    if (!mongo || !db) return;
    await db
      .collection('app_settings')
      .updateOne({ _id: 'network' }, { $set: { config: { enabled: false } } }, { upsert: true });
    const res = await getLocalAddress();
    const body = await res.json();
    expect(body).toEqual({ available: false });
  });

  it('PUT /api/network/config rejects an invalid IP override', async () => {
    if (!mongo) return;
    const res = await putConfig({ local_ip_override: 'bad value with spaces' });
    expect(res.status).toBe(400);
  });

  it('PUT /api/network/config rejects an out-of-range port override', async () => {
    if (!mongo) return;
    const res = await putConfig({ local_port_override: 70000 });
    expect(res.status).toBe(400);
  });

  it('PUT /api/network/config round-trips an override and null clears it', async () => {
    if (!mongo) return;
    const set = await putConfig({ local_ip_override: '192.168.1.10' });
    expect(set.status).toBe(200);
    const setBody = (await set.json()) as { local_ip: string; source: { local_ip: string } };
    expect(setBody.local_ip).toBe('192.168.1.10');
    expect(setBody.source.local_ip).toBe('db_override');

    const cleared = await putConfig({ local_ip_override: null });
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as { source: { local_ip: string } };
    expect(clearedBody.source.local_ip).not.toBe('db_override');
  });
});
