import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { signAccessToken } from '../auth/tokens.ts';
import { buildGoogleBackupRoutes } from './cloud-backup-google.ts';
import {
  managedFixture,
  managedServer,
  managedId,
} from '../cloud-backup/google/managed.test-helpers.ts';
import { loadConnection, saveConfig } from '../cloud-backup/google/repo.ts';
import { DEFAULT_GOOGLE_CONFIG } from '../cloud-backup/google/config.ts';

const origin = 'https://photos.example.com';
async function fixture() {
  const f = await managedFixture();
  const server = managedServer();
  const previous = process.env.MAPLE_JWT_SECRET;
  const secret = 'managed-route-test-secret-for-cookie-auth';
  process.env.MAPLE_JWT_SECRET = secret;
  const token = await signAccessToken(
    { sub: f.owner, email: null, role: 'owner', file_access: true },
    secret,
  );
  const transport: typeof server.transport = async (url, init) =>
    url.toString().includes('/files/attached-root?')
      ? Response.json({
          id: 'attached-root',
          name: 'Maple backup',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: true,
          parents: ['drive-parent'],
          description: JSON.stringify({ mapleBackupRoot: 1, identity: 'existing-backup' }),
        })
      : server.transport(url, init);
  const { owner } = buildGoogleBackupRoutes({
    origin: async () => origin,
    destination: (id) => f.repo.destination(id),
    connectionChanged: async (id) => {
      await f.repo.db.write('UPDATE backup_destinations SET generation=generation+1 WHERE id=?', [
        id,
      ]);
    },
    connectionRestored: async (id) => f.repo.clearResolvedGoogleConnectionErrors(id),
    attachRoot: async (id, root, account, generation) => {
      const result = await f.repo.db.write(
        'UPDATE backup_destinations SET root_id=?,account_id=? WHERE id=? AND generation=?',
        [root, account, id, generation],
      );
      if (result.changes !== 1) throw new Error('Destination changed');
    },
    transport,
  });
  const app = new Elysia().use(owner);
  return {
    ...f,
    server,
    request: (method: string, suffix: string, body?: unknown) =>
      app.handle(
        new Request(`${origin}/api/cloud-backup/google/${f.destination.id}/${suffix}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Origin: origin,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
    async [Symbol.asyncDispose]() {
      process.env.MAPLE_JWT_SECRET = previous;
      f.live.close();
    },
  };
}

test('managed config GET uses no remote lookup, saves validated metadata without local secret, and disconnect clears encrypted grants', async () => {
  await using f = await fixture();
  const projection = await f.request('GET', 'config');
  expect(await projection.json()).toMatchObject({
    clientMode: 'maple',
    clientSecretSet: false,
    mapleClientAvailable: true,
  });
  expect(f.server.requests).toHaveLength(0);
  const saved = await f.request('PUT', 'config', { clientMode: 'maple', callbackMode: 'direct' });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({
    clientMode: 'maple',
    clientId: managedId,
    clientSecretSet: false,
    callbackMode: 'relay',
  });
  const current = await loadConnection(f.destination.id);
  await saveConfig(
    f.destination.id,
    {
      ...current.config,
      refreshToken: 'stored-refresh',
      relayGrant: 'stored-grant',
      accountId: 'managed-account',
    },
    current.epoch,
  );
  expect((await f.request('POST', 'disconnect')).status).toBe(200);
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    clientMode: 'maple',
    clientId: managedId,
    refreshToken: null,
    relayGrant: null,
    clientSecret: '',
  });
});

for (const invalid of ['unavailable', 'scope', 'redirect', 'client'] as const) {
  test(`managed ${invalid} metadata prevents save and reports an actionable error`, async () => {
    await using f = await fixture();
    const mutations = {
      unavailable: () => {
        f.server.controls.metadata.available = false;
        f.server.controls.metadataStatus = 503;
      },
      scope: () => {
        f.server.controls.metadata.scope = 'https://www.googleapis.com/auth/drive';
      },
      redirect: () => {
        f.server.controls.metadata.redirectUri = 'https://evil.example/callback';
      },
      client: () => {
        f.server.controls.metadata.clientId = 'invalid-client';
      },
    };
    mutations[invalid]();
    const response = await f.request('PUT', 'config', {
      clientMode: 'maple',
      callbackMode: 'relay',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Maple Google application');
    expect((await loadConnection(f.destination.id)).epoch).toBe(0);
  });
}

test('managed save cannot recreate credential children after destination removal during metadata lookup', async () => {
  await using f = await fixture();
  f.server.controls.beforeMetadata = async () => {
    await f.repo.db.write('DELETE FROM backup_destinations WHERE id=?', [f.destination.id]);
  };
  expect(
    (await f.request('PUT', 'config', { clientMode: 'maple', callbackMode: 'relay' })).status,
  ).toBe(400);
  expect(f.live.db.query('SELECT * FROM backup_google_connections').all()).toEqual([]);
  expect(f.live.db.query('SELECT * FROM backup_google_oauth').all()).toEqual([]);
});

test('writer rechecks destination existence after the asynchronous credential seal', async () => {
  await using f = await fixture();
  const write = f.live.handle.write.bind(f.live.handle);
  f.live.handle.write = async (sql, params) => {
    if (sql.startsWith('INSERT INTO backup_google_connections'))
      f.live.db.query('DELETE FROM backup_destinations WHERE id=?').run(f.destination.id);
    return write(sql, params);
  };
  expect(
    (await f.request('PUT', 'config', { clientMode: 'maple', callbackMode: 'relay' })).status,
  ).toBe(400);
  expect(f.live.db.query('SELECT * FROM backup_google_connections').all()).toEqual([]);
});

test('a root attached while managed metadata is loading prevents an OAuth application switch', async () => {
  await using f = await fixture();
  const own = {
    ...DEFAULT_GOOGLE_CONFIG,
    clientMode: 'own' as const,
    clientId: '12345-own.apps.googleusercontent.com',
    clientSecret: 'own-secret',
    refreshToken: 'own-refresh',
  };
  await saveConfig(f.destination.id, own, 0);
  f.server.controls.beforeMetadata = async () => {
    await f.repo.db.write('UPDATE backup_destinations SET root_id=? WHERE id=?', [
      'attached-root',
      f.destination.id,
    ]);
  };
  expect(
    (await f.request('PUT', 'config', { clientMode: 'maple', callbackMode: 'relay' })).status,
  ).toBe(400);
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    clientMode: 'own',
    clientId: own.clientId,
    refreshToken: 'own-refresh',
  });
});

test('writer rechecks root binding after sealing a new managed application configuration', async () => {
  await using f = await fixture();
  const own = {
    ...DEFAULT_GOOGLE_CONFIG,
    clientMode: 'own' as const,
    clientId: '12345-own.apps.googleusercontent.com',
    clientSecret: 'own-secret',
  };
  await saveConfig(f.destination.id, own, 0);
  const write = f.live.handle.write.bind(f.live.handle);
  f.live.handle.write = async (sql, params) => {
    if (sql.startsWith('INSERT INTO backup_google_connections'))
      f.live.db
        .query('UPDATE backup_destinations SET root_id=? WHERE id=?')
        .run('attached-root', f.destination.id);
    return write(sql, params);
  };
  expect(
    (await f.request('PUT', 'config', { clientMode: 'maple', callbackMode: 'relay' })).status,
  ).toBe(400);
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    clientMode: 'own',
    clientId: own.clientId,
  });
});

test('same managed application saves and root attachment preserve its existing renewal authority', async () => {
  await using f = await fixture();
  await saveConfig(
    f.destination.id,
    {
      ...DEFAULT_GOOGLE_CONFIG,
      clientId: managedId,
      refreshToken: 'existing-refresh',
      relayGrant: 'existing-grant',
      accountId: 'managed-account',
    },
    0,
  );
  const saved = await f.request('PUT', 'config', { clientMode: 'maple', callbackMode: 'relay' });
  expect(saved.status).toBe(200);
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    refreshToken: 'existing-refresh',
    relayGrant: 'existing-grant',
  });
  const attach = await f.request('PUT', 'config', {
    clientMode: 'maple',
    callbackMode: 'relay',
    rootId: 'attached-root',
  });
  expect(attach.status).toBe(200);
  expect((await f.repo.destination(f.destination.id))!.rootId).toBe('attached-root');
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    refreshToken: 'rotated-refresh',
    relayGrant: 'rotated-grant',
  });
});

test('attached roots cannot change application, and managed mode rejects user secrets instead of storing them', async () => {
  await using f = await fixture();
  await saveConfig(f.destination.id, { ...DEFAULT_GOOGLE_CONFIG, clientId: managedId }, 0);
  f.live.db
    .query('UPDATE backup_destinations SET root_id=? WHERE id=?')
    .run('attached-root', f.destination.id);
  expect(
    (
      await f.request('PUT', 'config', {
        clientMode: 'own',
        clientId: '12345-own.apps.googleusercontent.com',
        clientSecret: 'private-own-secret',
        callbackMode: 'direct',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.request('PUT', 'config', {
        clientMode: 'maple',
        clientSecret: 'do-not-store',
        callbackMode: 'relay',
      })
    ).status,
  ).toBe(400);
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    clientMode: 'maple',
    clientId: managedId,
    clientSecret: '',
  });
});
