import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { type Db } from 'mongodb';
import { apnsDeviceRoutes } from './apns-devices.ts';
import { closeDb, getDb, isDbConnected } from '../db/client.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';

withTestDb(`maple_test_apns_devices_route_${process.pid}`);

let db: Db | null = null;
let mongoReachable = false;

beforeAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  await db.collection('apns_device_tokens').deleteMany({});
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  await closeDb();
});

const USER_A = '0'.repeat(24);
const USER_B = '1'.repeat(24);

// Realistic-shaped fake tokens — 64 lowercase hex chars, matching the
// modern 32-byte APNs device token format the route now validates against.
const TOKEN_1 = 'a1'.repeat(32);
const TOKEN_2 = 'b2'.repeat(32);
const TOKEN_3 = 'c3'.repeat(32);

function appAs(sub: string): Elysia {
  return new Elysia().use(fakeAuth({ sub })).use(apnsDeviceRoutes);
}

async function postDevice(
  app: Elysia,
  deviceToken: string,
  overrides: Partial<{ platform: string; environment: string }> = {},
): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/apns/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        device_token: deviceToken,
        platform: overrides.platform ?? 'ios',
        environment: overrides.environment ?? 'sandbox',
      }),
    }),
  );
}

describe('/api/apns/devices', () => {
  it('rejects a member without file_access (registering a device subscribes to server-wide change activity, same tier as the change-feed routes)', async () => {
    if (!mongoReachable) return;
    const app = new Elysia()
      .use(fakeAuth({ sub: USER_A, role: 'member', file_access: false }))
      .use(apnsDeviceRoutes);
    const res = await app.handle(new Request('http://localhost/api/apns/devices'));
    expect(res.status).toBe(403);
  });

  it('POST registers a device, GET lists it back for the same user', async () => {
    if (!mongoReachable) return;
    const app = appAs(USER_A);
    const post = await postDevice(app, TOKEN_1);
    expect(post.status).toBe(204);

    const list = await app.handle(new Request('http://localhost/api/apns/devices'));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { devices: Array<{ device_token: string }> };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]!.device_token).toBe(TOKEN_1);
  });

  it('POST rejects a malformed device_token (not hex, or too short)', async () => {
    if (!mongoReachable) return;
    const res = await postDevice(appAs(USER_A), 'not-a-real-token');
    expect(res.status).toBe(400);
  });

  it('POST normalizes case and surrounding whitespace before storing', async () => {
    if (!mongoReachable) return;
    const app = appAs(USER_A);
    const post = await postDevice(app, `  ${TOKEN_1.toUpperCase()}  `);
    expect(post.status).toBe(204);
    const list = await app.handle(new Request('http://localhost/api/apns/devices'));
    const body = (await list.json()) as { devices: Array<{ device_token: string }> };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]!.device_token).toBe(TOKEN_1);
  });

  it('re-registering the same token under different case does not duplicate', async () => {
    if (!mongoReachable) return;
    const app = appAs(USER_A);
    await postDevice(app, TOKEN_1);
    await postDevice(app, TOKEN_1.toUpperCase());
    const list = await app.handle(new Request('http://localhost/api/apns/devices'));
    const body = (await list.json()) as { devices: unknown[] };
    expect(body.devices).toHaveLength(1);
  });

  it('GET only returns the caller own devices, not another user’s', async () => {
    if (!mongoReachable) return;
    await postDevice(appAs(USER_A), TOKEN_2);
    const listB = await appAs(USER_B).handle(new Request('http://localhost/api/apns/devices'));
    const bodyB = (await listB.json()) as { devices: unknown[] };
    expect(bodyB.devices).toHaveLength(0);
  });

  it('DELETE unregisters a device', async () => {
    if (!mongoReachable) return;
    const app = appAs(USER_A);
    await postDevice(app, TOKEN_3);
    const del = await app.handle(
      new Request('http://localhost/api/apns/devices', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_token: TOKEN_3 }),
      }),
    );
    expect(del.status).toBe(204);
    const list = await app.handle(new Request('http://localhost/api/apns/devices'));
    const body = (await list.json()) as { devices: unknown[] };
    expect(body.devices).toHaveLength(0);
  });

  it('DELETE rejects a malformed device_token', async () => {
    if (!mongoReachable) return;
    const res = await appAs(USER_A).handle(
      new Request('http://localhost/api/apns/devices', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_token: 'nope' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
