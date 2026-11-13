import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { withTestEnv } from '../test-support/env.test-helpers.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { temporalRoutes } from '../workers/routes-temporal.ts';
import {
  DEFAULT_TEMPORAL_ADDRESS,
  DEFAULT_TEMPORAL_NAMESPACE,
  loadTemporalSettings,
  readTemporalStatus,
  reportTemporalConnection,
  saveTemporalSettings,
  TemporalSettingsError,
} from './temporal-config.ts';

const NOW = 1_800_000_000_000;

describe('Temporal settings with nothing in the environment', () => {
  withTestEnv('MAPLE_TEMPORAL_ADDRESS', '');

  test('default to a local server', async () => {
    using _live = await createLiveTestDatabase();
    expect(await loadTemporalSettings()).toEqual({
      address: DEFAULT_TEMPORAL_ADDRESS,
      namespace: DEFAULT_TEMPORAL_NAMESPACE,
    });
  });

  test('GET /temporal returns them with an unknown connection', async () => {
    using _live = await createLiveTestDatabase();
    const response = await new Elysia()
      .use(temporalRoutes)
      .handle(new Request('http://localhost/temporal'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      address: DEFAULT_TEMPORAL_ADDRESS,
      namespace: DEFAULT_TEMPORAL_NAMESPACE,
      connection: { state: 'unknown', error: null, checkedAt: null },
    });
  });
});

describe('Temporal settings', () => {
  withTestEnv('MAPLE_TEMPORAL_ADDRESS', 'from-env:7233');

  test('take the address from the environment until one is saved', async () => {
    using _live = await createLiveTestDatabase();
    expect(await loadTemporalSettings()).toEqual({
      address: 'from-env:7233',
      namespace: DEFAULT_TEMPORAL_NAMESPACE,
    });

    await saveTemporalSettings({ address: ' saved.example:7233 ', namespace: 'photos' });

    expect(await loadTemporalSettings()).toEqual({
      address: 'saved.example:7233',
      namespace: 'photos',
    });
  });

  test.each([
    ['temporal', 'default'],
    ['http://temporal:7233', 'default'],
    ['temporal:port', 'default'],
    ['temporal:70000', 'default'],
    ['temporal:0', 'default'],
    ['user@temporal:7233', 'default'],
    ['temporal?x:7233', 'default'],
    ['temporal:7233', 'has space'],
    ['temporal:7233', ''],
  ])('rejects address %p with namespace %p', async (address, namespace) => {
    using _live = await createLiveTestDatabase();
    await expect(saveTemporalSettings({ address, namespace })).rejects.toBeInstanceOf(
      TemporalSettingsError,
    );
  });

  test('accepts a bracketed IPv6 address', async () => {
    using _live = await createLiveTestDatabase();
    await saveTemporalSettings({ address: '[::1]:7233', namespace: 'default' });
    expect((await loadTemporalSettings()).address).toBe('[::1]:7233');
  });
});

describe('Temporal connection status', () => {
  const target = { address: 'temporal:7233', namespace: 'maple' };

  test('is unknown until the worker tier reports', async () => {
    using _live = await createLiveTestDatabase();
    await saveTemporalSettings(target);
    expect(await readTemporalStatus(NOW)).toEqual({
      ...target,
      connection: { state: 'unknown', error: null, checkedAt: null },
    });
  });

  test('carries a fresh report about the saved target', async () => {
    using _live = await createLiveTestDatabase();
    await saveTemporalSettings(target);
    await reportTemporalConnection({
      ...target,
      state: 'unreachable',
      error: 'Connection refused',
      checkedAt: NOW - 1_000,
    });

    expect((await readTemporalStatus(NOW)).connection).toEqual({
      state: 'unreachable',
      error: 'Connection refused',
      checkedAt: NOW - 1_000,
    });
  });

  test('ignores a report about a target that has since been changed', async () => {
    using _live = await createLiveTestDatabase();
    await saveTemporalSettings(target);
    await reportTemporalConnection({ ...target, state: 'connected', error: null, checkedAt: NOW });

    await saveTemporalSettings({ address: 'elsewhere:7233', namespace: 'maple' });

    expect((await readTemporalStatus(NOW)).connection.state).toBe('unknown');
  });

  test('ignores a report the worker tier stopped refreshing', async () => {
    using _live = await createLiveTestDatabase();
    await saveTemporalSettings(target);
    await reportTemporalConnection({
      ...target,
      state: 'connected',
      error: null,
      checkedAt: NOW - 60_000,
    });

    expect((await readTemporalStatus(NOW)).connection).toEqual({
      state: 'unknown',
      error: null,
      checkedAt: NOW - 60_000,
    });
  });
});

describe('/temporal routes', () => {
  const app = (role: 'owner' | 'member' = 'owner') =>
    new Elysia().use(fakeAuth({ role })).use(temporalRoutes);
  const put = (body: unknown, role: 'owner' | 'member' = 'owner') =>
    app(role).handle(
      new Request('http://localhost/temporal', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  test('PUT saves and returns the new target', async () => {
    using _live = await createLiveTestDatabase();
    const response = await put({ address: 'temporal:7233', namespace: 'maple' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ address: 'temporal:7233', namespace: 'maple' });
    expect(await loadTemporalSettings()).toEqual({ address: 'temporal:7233', namespace: 'maple' });
  });

  test('PUT is refused for a member, who can still read', async () => {
    using _live = await createLiveTestDatabase();
    const refused = await put({ address: 'temporal:7233', namespace: 'maple' }, 'member');

    expect(refused.status).toBe(403);
    expect((await loadTemporalSettings()).address).not.toBe('temporal:7233');
    const read = await app('member').handle(new Request('http://localhost/temporal'));
    expect(read.status).toBe(200);
  });

  test('PUT explains a malformed address', async () => {
    using _live = await createLiveTestDatabase();
    const response = await put({ address: 'temporal', namespace: 'maple' });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('host:port');
  });
});
