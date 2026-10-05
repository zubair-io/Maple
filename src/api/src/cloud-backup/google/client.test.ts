import { expect, test } from 'bun:test';
import { createGoogleRoot, DriveClient, DRIVE_API, type DriveFile } from './client.ts';
import type { GoogleFetch } from './oauth.ts';

function ownedRoot(id = 'reserved-folder'): DriveFile {
  return {
    id,
    name: 'Maple Photo Backup',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['my-drive'],
    ownedByMe: true,
    description: JSON.stringify({ mapleBackupRoot: 1, identity: 'stable-backup-identity' }),
  };
}
function rootServer() {
  const files = new Map<string, DriveFile>();
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const controls = { loseCreate: false, conflict: false, metadataStatus: 0 };
  const transport: GoogleFetch = async (input, init = {}) => {
    const url = new URL(input.toString());
    requests.push({ url, init });
    if (url.pathname.endsWith('/generateIds')) return Response.json({ ids: ['reserved-folder'] });
    if (init.method === 'POST') {
      const metadata = JSON.parse(String(init.body)) as DriveFile;
      files.set(metadata.id, { ...metadata, parents: ['my-drive'], ownedByMe: true });
      if (controls.loseCreate) throw new Error('Response lost after Google stored the folder');
      return Response.json(files.get(metadata.id), { status: controls.conflict ? 409 : 200 });
    }
    if (controls.metadataStatus) return new Response(null, { status: controls.metadataStatus });
    const file = files.get(url.pathname.split('/').at(-1)!);
    return file ? Response.json(file) : new Response(null, { status: 404 });
  };
  return { files, requests, controls, transport };
}

test('root creation allocates one visible My Drive folder using the current local access token', async () => {
  const server = rootServer();
  expect(await createGoogleRoot(async () => 'local-access', server.transport)).toBe(
    'reserved-folder',
  );
  expect(server.files.size).toBe(1);
  const creation = server.requests.find((request) => request.init.method === 'POST')!;
  const metadata = JSON.parse(String(creation.init.body));
  expect(metadata).toMatchObject({
    id: 'reserved-folder',
    name: 'Maple Photo Backup',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['root'],
  });
  expect(JSON.parse(metadata.description)).toMatchObject({ mapleBackupRoot: 1 });
  expect(JSON.parse(metadata.description).identity).toMatch(/^[\da-f-]{36}$/);
  for (const request of server.requests) {
    expect(request.url.origin).toBe('https://www.googleapis.com');
    expect(new Headers(request.init.headers).get('authorization')).toBe('Bearer local-access');
    expect(request.init.redirect).toBe('error');
  }
});

test('retry after a lost create response recovers the reserved folder without duplicating it', async () => {
  const server = rootServer();
  server.controls.loseCreate = true;
  await expect(
    createGoogleRoot(async () => 'first-token', server.transport, 'reserved-folder'),
  ).rejects.toThrow('Google Drive request failed (0)');
  server.controls.loseCreate = false;
  const identity = server.files.get('reserved-folder')!.description;
  expect(
    await createGoogleRoot(async () => 'renewed-token', server.transport, 'reserved-folder'),
  ).toBe('reserved-folder');
  expect(server.files.size).toBe(1);
  expect(server.files.get('reserved-folder')!.description).toBe(identity);
  expect(server.requests.filter((request) => request.init.method === 'POST')).toHaveLength(1);
  expect(new Headers(server.requests.at(-1)!.init.headers).get('authorization')).toBe(
    'Bearer renewed-token',
  );
});

test('a competing create at the reserved ID is accepted only after validating its ownership marker', async () => {
  const server = rootServer();
  server.controls.conflict = true;
  expect(await createGoogleRoot(async () => 'token', server.transport, 'reserved-folder')).toBe(
    'reserved-folder',
  );
  expect(server.requests.map((request) => request.init.method ?? 'GET')).toEqual([
    'GET',
    'POST',
    'GET',
  ]);
  server.files.set('reserved-folder', { ...ownedRoot(), ownedByMe: false });
  await expect(
    createGoogleRoot(async () => 'token', server.transport, 'reserved-folder'),
  ).rejects.toThrow('Maple-owned backup folder');
  expect(server.requests.filter((request) => request.init.method === 'POST')).toHaveLength(1);
});

test('inaccessible reserved folders block creation rather than allocating a replacement', async () => {
  const server = rootServer();
  server.controls.metadataStatus = 403;
  await expect(
    createGoogleRoot(async () => 'token', server.transport, 'reserved-folder'),
  ).rejects.toThrow('denied access');
  expect(server.requests).toHaveLength(1);
  expect(server.files.size).toBe(0);
});

test('Drive endpoint and file ID validation prevents sending credentials to an arbitrary host', async () => {
  const server = rootServer();
  const client = new DriveClient(async () => 'private-token', server.transport);
  await expect(client.request('https://example.com/drive/v3/files')).rejects.toThrow(
    'Invalid Google Drive endpoint',
  );
  await expect(client.request('https://www.googleapis.com/other')).rejects.toThrow(
    'Invalid Google Drive endpoint',
  );
  expect(() => client.metadata('../other')).toThrow('Invalid Google file identifier');
  expect(server.requests).toHaveLength(0);
  await client.request(`${DRIVE_API}/files/generateIds`);
  expect(server.requests).toHaveLength(1);
});
