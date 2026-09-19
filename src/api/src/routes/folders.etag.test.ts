/**
 * `GET /api/folders` — body-hash ETag and the If-None-Match short-circuit the
 * File Provider extension revalidates against on a cold Finder open.
 *
 * The handler reaches `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the block.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { foldersRoutes } from './folders.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

describe('GET /api/folders — ETag', () => {
  let live: LiveTestDatabase;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    insertFolder(live.db, { path: '/srv/p', slug: 'p' });
  });

  afterEach(() => {
    live.close();
  });

  it('returns ETag header on 200', async () => {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const res = await app.handle(new Request('http://localhost/api/folders'));
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toMatch(/^"[a-f0-9]+"$/);
  });

  it('returns 304 when If-None-Match matches', async () => {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const first = await app.handle(new Request('http://localhost/api/folders'));
    const etag = first.headers.get('ETag')!;
    const second = await app.handle(
      new Request('http://localhost/api/folders', {
        headers: { 'If-None-Match': etag },
      }),
    );
    expect(second.status).toBe(304);
    expect((await second.text()).length).toBe(0);
    expect(second.headers.get('ETag')).toBe(etag);
  });

  it('returns 200 with a new ETag when folders change', async () => {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const first = await app.handle(new Request('http://localhost/api/folders'));
    const etag1 = first.headers.get('ETag')!;
    insertFolder(live.db, { path: '/srv/q', slug: 'q' });
    const second = await app.handle(
      new Request('http://localhost/api/folders', {
        headers: { 'If-None-Match': etag1 },
      }),
    );
    expect(second.status).toBe(200);
    expect(second.headers.get('ETag')).not.toBe(etag1);
  });
});
