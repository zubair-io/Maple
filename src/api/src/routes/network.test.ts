/**
 * Route-integration test: GET/PUT /api/network/*
 *
 * Covers: the public report route requires no Authorization header (the
 * regression that matters most, since this endpoint is deliberately mounted
 * outside the `requireAuth` sub-app), reflects a saved override, and reports
 * `available: false` when disabled. The config CRUD route validates input
 * and round-trips overrides.
 *
 * The saved override is the `network` row of `app_settings`, so the two cases
 * that need one seeded write it through `saveNetworkConfig` — the same
 * `patchAppSettings` path the PUT route uses (#3787) — against a private
 * SQLite database installed as the process-wide handle for the test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { networkPublicRoutes, networkSettingsRoutes } from './network.ts';
import { saveNetworkConfig } from '../network/network-config.repo.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

describe('/api/network/*', () => {
  let live: LiveTestDatabase;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
  });

  afterEach(() => {
    live.close();
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
    const res = await getLocalAddress();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean };
    expect(typeof body.available).toBe('boolean');
  });

  it('reflects a saved local_ip_override', async () => {
    await saveNetworkConfig({ local_ip_override: '10.0.0.5', local_port_override: 4000 });
    const res = await getLocalAddress();
    const body = (await res.json()) as {
      available: boolean;
      ip?: string;
      port?: number;
      scheme?: string;
    };
    expect(body).toEqual({ available: true, ip: '10.0.0.5', port: 4000, scheme: 'http' });
  });

  it('reports available: false when disabled', async () => {
    await saveNetworkConfig({ enabled: false });
    const res = await getLocalAddress();
    const body = await res.json();
    expect(body).toEqual({ available: false });
  });

  it('PUT /api/network/config rejects an invalid IP override', async () => {
    const res = await putConfig({ local_ip_override: 'bad value with spaces' });
    expect(res.status).toBe(400);
  });

  it('PUT /api/network/config rejects an out-of-range port override', async () => {
    const res = await putConfig({ local_port_override: 70000 });
    expect(res.status).toBe(400);
  });

  it('PUT /api/network/config round-trips an override and null clears it', async () => {
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
