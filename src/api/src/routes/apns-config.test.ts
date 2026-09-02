import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { type Db } from 'mongodb';
import { apnsConfigRoutes } from './apns-config.ts';
import { closeDb, getDb, isDbConnected } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';

withTestDb(`maple_test_apns_config_route_${process.pid}`);

let db: Db | null = null;
let mongoReachable = false;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['MAPLE_APNS_KEY_ID', 'MAPLE_APNS_TEAM_ID', 'MAPLE_APNS_PRIVATE_KEY'] as const;

beforeAll(async () => {
  await closeDb();
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  await closeDb();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  await db.collection('app_settings').deleteMany({ _id: 'apns' });
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

function app(): Elysia {
  return new Elysia().use(apnsConfigRoutes);
}

async function getConfig(): Promise<{ enabled: boolean; credentials_configured: boolean }> {
  const res = await app().handle(new Request('http://localhost/api/apns/config'));
  return res.json();
}

async function putConfig(body: unknown): Promise<Response> {
  return app().handle(
    new Request('http://localhost/api/apns/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('/api/apns/config', () => {
  it('defaults to disabled with no credentials configured', async () => {
    if (!mongoReachable) return;
    const cfg = await getConfig();
    expect(cfg).toEqual({ enabled: false, credentials_configured: false });
  });

  it('reports credentials_configured true once the three env vars are set', async () => {
    if (!mongoReachable) return;
    process.env.MAPLE_APNS_KEY_ID = 'A';
    process.env.MAPLE_APNS_TEAM_ID = 'B';
    process.env.MAPLE_APNS_PRIVATE_KEY = 'C';
    const cfg = await getConfig();
    expect(cfg.credentials_configured).toBe(true);
  });

  it('PUT round-trips enabled: true', async () => {
    if (!mongoReachable) return;
    const res = await putConfig({ enabled: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(true);
    expect((await getConfig()).enabled).toBe(true);
  });

  it('PUT enabled: false turns it back off', async () => {
    if (!mongoReachable) return;
    await putConfig({ enabled: true });
    await putConfig({ enabled: false });
    expect((await getConfig()).enabled).toBe(false);
  });
});
