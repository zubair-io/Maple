// #4746: a member whose file access was revoked must not download raw files
// by library path, read their absolute server path, or move files on disk.
// Siblings in the same modules were already gated (#2893); these were not.
import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { foldersRoutes } from './folders.ts';
import { libraryRelocateRoutes } from './library-relocate.ts';

type Row = {
  name: string;
  routes: Elysia;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
};

const folderId = 'a'.repeat(24);
const rows: Row[] = [
  {
    name: 'raw file download',
    routes: foldersRoutes as unknown as Elysia,
    method: 'GET',
    path: `/api/folders/${folderId}/file?path=IMG_0001.dng`,
  },
  {
    name: 'raw file metadata',
    routes: foldersRoutes as unknown as Elysia,
    method: 'GET',
    path: `/api/folders/${folderId}/file-meta?path=IMG_0001.dng`,
  },
  {
    name: 'library relocate count',
    routes: libraryRelocateRoutes as unknown as Elysia,
    method: 'POST',
    path: '/api/library/relocate-count',
    body: { addresses: ['lib/IMG_0001.dng'] },
  },
  {
    name: 'library relocate',
    routes: libraryRelocateRoutes as unknown as Elysia,
    method: 'POST',
    path: '/api/library/relocate',
    body: { addresses: ['lib/IMG_0001.dng'] },
  },
];

function request(row: Row): Request {
  const init: RequestInit = { method: row.method };
  if (row.body !== undefined) {
    init.body = JSON.stringify(row.body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request(`http://localhost${row.path}`, init);
}

describe('file-access gate on download and relocate routes (#4746)', () => {
  for (const row of rows) {
    test(`${row.name}: member without file access gets 403`, async () => {
      const app = new Elysia()
        .use(fakeAuth({ role: 'member', file_access: false }))
        .use(row.routes);
      const res = await app.handle(request(row));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'file access permission required' });
    });
  }
});
