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
    expect(request.init.redirect).toBe('manual');
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

const uploadSession = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=owned-session';
const protocolCases = [
  {
    name: 'resumable PUT progress',
    status: 308,
    method: 'PUT',
    url: uploadSession,
    location: null,
    accepted: true,
  },
  {
    name: 'GET progress',
    status: 308,
    method: 'GET',
    url: uploadSession,
    location: null,
    accepted: false,
  },
  {
    name: 'session creation progress',
    status: 308,
    method: 'POST',
    url: uploadSession,
    location: null,
    accepted: false,
  },
  {
    name: 'non-session upload progress',
    status: 308,
    method: 'PUT',
    url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    location: null,
    accepted: false,
  },
  {
    name: 'Drive metadata progress',
    status: 308,
    method: 'PUT',
    url: `${DRIVE_API}/files/owned-id?upload_id=owned-session`,
    location: null,
    accepted: false,
  },
  {
    name: 'Google Location on progress',
    status: 308,
    method: 'PUT',
    url: uploadSession,
    location: uploadSession,
    accepted: false,
  },
  {
    name: '302 redirect',
    status: 302,
    method: 'PUT',
    url: uploadSession,
    location: 'loopback',
    accepted: false,
  },
  {
    name: '307 redirect',
    status: 307,
    method: 'PUT',
    url: uploadSession,
    location: 'loopback',
    accepted: false,
  },
] as const;
for (const fixture of protocolCases) {
  test(`native Bun transport ${fixture.accepted ? 'accepts' : 'rejects'} ${fixture.name} without following redirects`, async () => {
    const requests: Array<{ path: string; authorization: string | null }> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get('authorization'),
        });
        const location =
          fixture.location === 'loopback'
            ? new URL('/redirect-target', request.url).href
            : fixture.location;
        return new Response('native protocol response', {
          status: fixture.status,
          headers: { Range: 'bytes=0-8388607', ...(location ? { Location: location } : {}) },
        });
      },
    });
    const redirectModes: Array<RequestRedirect | undefined> = [];
    const transport: GoogleFetch = async (_input, init) => {
      redirectModes.push(init?.redirect);
      return fetch(`http://127.0.0.1:${server.port}/session`, init);
    };
    try {
      const client = new DriveClient(async () => 'disposable-fixture-token', transport);
      const request = client.request(fixture.url, { method: fixture.method, redirect: 'follow' });
      if (fixture.accepted) {
        const response = await request;
        expect(response.status).toBe(308);
        expect(response.headers.get('range')).toBe('bytes=0-8388607');
        expect(await response.text()).toBe('native protocol response');
      } else
        await expect(request).rejects.toThrow(`Google Drive request failed (${fixture.status})`);
      expect(redirectModes).toEqual(['manual']);
      expect(requests).toEqual([
        { path: '/session', authorization: 'Bearer disposable-fixture-token' },
      ]);
    } finally {
      await server.stop(true);
    }
  });
}
