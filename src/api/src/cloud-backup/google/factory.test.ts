import { expect, test } from 'bun:test';
import { createLiveTestDatabase, insertFolder } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from '../repository.ts';
import { providerForDestination } from './factory.ts';
import { DEFAULT_GOOGLE_CONFIG, DRIVE_SCOPE } from './config.ts';
import { loadConnection, saveConfig } from './repo.ts';
import type { GoogleFetch } from './oauth.ts';

const clientId = '12345-example.apps.googleusercontent.com';
async function connectedDestination() {
  const live = await createLiveTestDatabase();
  const repo = new BackupRepository();
  const created = await repo.createDestination({
    libraryId: insertFolder(live.db),
    kind: 'google-drive',
    name: 'Google photos',
    path: null,
  });
  live.db
    .query('UPDATE backup_destinations SET root_id=?,account_id=?,enabled=1 WHERE id=?')
    .run('maple-root', 'account-1', created.id);
  await saveConfig(
    created.id,
    {
      ...DEFAULT_GOOGLE_CONFIG,
      clientMode: 'own',
      clientId,
      clientSecret: 'local-secret',
      refreshToken: 'local-refresh',
      accountId: 'account-1',
    },
    0,
  );
  return { live, repo, destination: (await repo.destination(created.id))! };
}
function googleServer(beforeToken?: () => Promise<void>, accountId = 'account-1') {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const transport: GoogleFetch = async (input, init = {}) => {
    const url = input.toString();
    requests.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') {
      await beforeToken?.();
      return Response.json({
        access_token: 'renewed-access',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    if (url === 'https://oauth2.googleapis.com/tokeninfo')
      return Response.json({ aud: clientId, scope: DRIVE_SCOPE });
    if (url.includes('/about?'))
      return Response.json({
        user: { permissionId: accountId, emailAddress: 'owner@example.com' },
      });
    if (url.includes('/files/maple-root?'))
      return Response.json({
        id: 'maple-root',
        name: 'Maple Photo Backup',
        ownedByMe: true,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['my-drive'],
        description: JSON.stringify({ mapleBackupRoot: 1, identity: 'backup-identity' }),
      });
    throw new Error('Unexpected Google request');
  };
  return { requests, transport };
}
function installFetch(transport: GoogleFetch): Disposable {
  const original = globalThis.fetch;
  globalThis.fetch = transport as typeof fetch;
  return {
    [Symbol.dispose]() {
      globalThis.fetch = original;
    },
  };
}

test('a captured provider renews locally and authenticates only the selected root, then reuses its token', async () => {
  const { live, destination } = await connectedDestination();
  using _database = live;
  const server = googleServer();
  using _fetch = installFetch(server.transport);
  const provider = providerForDestination(destination);
  await provider.probe();
  await provider.probe();
  const renewal = server.requests.filter((request) => request.url.endsWith('/token'));
  expect(renewal).toHaveLength(1);
  expect(Object.fromEntries(renewal[0]!.init.body as URLSearchParams)).toEqual({
    client_id: clientId,
    client_secret: 'local-secret',
    refresh_token: 'local-refresh',
    grant_type: 'refresh_token',
  });
  const reads = server.requests.filter((request) => request.url.includes('/files/'));
  expect(reads).toHaveLength(2);
  for (const read of reads) {
    expect(new URL(read.url).pathname).toBe('/drive/v3/files/maple-root');
    expect(new Headers(read.init.headers).get('authorization')).toBe('Bearer renewed-access');
  }
  expect((await loadConnection(destination.id)).config.refreshToken).toBe('local-refresh');
});

test('a paused destination fences an already captured provider before any Google request', async () => {
  const { live, repo, destination } = await connectedDestination();
  using _database = live;
  const server = googleServer();
  using _fetch = installFetch(server.transport);
  const provider = providerForDestination(destination);
  await repo.updateDestination(destination.id, { enabled: false });
  await expect(provider.probe()).rejects.toThrow('destination changed; retry');
  expect(server.requests).toHaveLength(0);
});

test('rebinding to a different root without a generation bump still fences the captured provider', async () => {
  const { live, destination } = await connectedDestination();
  using _database = live;
  const server = googleServer();
  using _fetch = installFetch(server.transport);
  const provider = providerForDestination(destination);
  live.db
    .query('UPDATE backup_destinations SET root_id=? WHERE id=?')
    .run('different-root', destination.id);
  await expect(provider.probe()).rejects.toThrow('destination changed; retry');
  expect(server.requests).toHaveLength(0);
});

for (const change of ['pause', 'root', 'delete'] as const) {
  test(`${change} during token renewal blocks the captured provider before it touches Drive files`, async () => {
    const { live, repo, destination } = await connectedDestination();
    using _database = live;
    const mutations = {
      pause: () => repo.updateDestination(destination.id, { enabled: false }),
      root: async () => {
        live.db
          .query('UPDATE backup_destinations SET root_id=? WHERE id=?')
          .run('other-root', destination.id);
      },
      delete: async () => {
        live.db.query('DELETE FROM backup_destinations WHERE id=?').run(destination.id);
      },
    };
    const server = googleServer(mutations[change]);
    using _fetch = installFetch(server.transport);
    await expect(providerForDestination(destination).probe()).rejects.toThrow(
      change === 'delete'
        ? 'Google connection changed'
        : 'destination changed during token renewal',
    );
    expect(server.requests.some((request) => request.url.includes('/files/'))).toBe(false);
    expect(server.requests.filter((request) => request.url.endsWith('/token'))).toHaveLength(1);
  });
}

test('a valid connection to another account cannot access the captured destination root', async () => {
  const { live, destination } = await connectedDestination();
  using _database = live;
  const connection = await loadConnection(destination.id);
  await saveConfig(
    destination.id,
    { ...connection.config, accountId: 'account-2' },
    connection.epoch,
  );
  const server = googleServer(undefined, 'account-2');
  using _fetch = installFetch(server.transport);
  await expect(providerForDestination(destination).probe()).rejects.toThrow(
    'Reconnect the original Google account',
  );
  expect(server.requests.some((request) => request.url.includes('/files/'))).toBe(false);
});

test('deletion before transfer and an unconnected destination fail before networking', async () => {
  const { live, destination } = await connectedDestination();
  using _database = live;
  const server = googleServer();
  using _fetch = installFetch(server.transport);
  const provider = providerForDestination(destination);
  live.db.query('DELETE FROM backup_destinations WHERE id=?').run(destination.id);
  await expect(provider.probe()).rejects.toThrow('destination changed; retry');
  expect(() => providerForDestination({ ...destination, rootId: null })).toThrow(
    'select its Maple backup folder',
  );
  expect(() => providerForDestination({ ...destination, kind: 'folder' })).toThrow(
    'Connect Google Drive',
  );
  expect(server.requests).toHaveLength(0);
});
