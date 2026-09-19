/**
 * Route-integration test: GET/PUT /api/apns/config.
 *
 * The document behind these routes is the `apns` row of `app_settings`, read
 * and written through `readAppSettings` / `patchAppSettings` (#3787). The route
 * reaches the process-wide SQLite handle with no override, so each test
 * installs one with `createLiveTestDatabase()`.
 *
 * A private database per test is also what replaces the
 * `deleteMany({ _id: 'apns' })` the MongoDB version ran before every case: the
 * "no operator has touched this yet" state is now the state a fresh database is
 * already in.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { apnsConfigRoutes } from './apns-config.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['MAPLE_APNS_KEY_ID', 'MAPLE_APNS_TEAM_ID', 'MAPLE_APNS_PRIVATE_KEY'] as const;

beforeAll(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
});

afterEach(() => {
  live.close();
  for (const k of ENV_KEYS) delete process.env[k];
});

function app() {
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
    const cfg = await getConfig();
    expect(cfg).toEqual({ enabled: false, credentials_configured: false });
  });

  it('reports credentials_configured true once the three env vars are set', async () => {
    process.env.MAPLE_APNS_KEY_ID = 'A';
    process.env.MAPLE_APNS_TEAM_ID = 'B';
    process.env.MAPLE_APNS_PRIVATE_KEY = 'C';
    const cfg = await getConfig();
    expect(cfg.credentials_configured).toBe(true);
  });

  it('PUT round-trips enabled: true', async () => {
    const res = await putConfig({ enabled: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(true);
    expect((await getConfig()).enabled).toBe(true);
  });

  it('PUT enabled: false turns it back off', async () => {
    await putConfig({ enabled: true });
    await putConfig({ enabled: false });
    expect((await getConfig()).enabled).toBe(false);
  });
});
