import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { fsRoutes } from './fs.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

/**
 * The ETag is computed over the enriched listing, and enriching it is what
 * takes `GET /api/fs/dir` to the database: `listDirContents` asks for the
 * registered library roots and pairs every visible filename against the
 * indexed assets. Those reads go through the process-wide handle with no
 * override, so the database has to be installed as that handle rather than
 * handed in — a route handler has nowhere to put one (#3787).
 *
 * Nothing is seeded. The directory under test is a temporary one that no
 * library owns, so an empty database is the honest fixture: what these cases
 * assert is that the hash changes when the directory does, and that
 * `If-None-Match` short-circuits when it has not.
 */
describe('GET /api/fs/dir — ETag', () => {
  let tmp: string | null = null;
  let live: LiveTestDatabase | null = null;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-fs-etag-')));
    process.env.MAPLE_ROOTS = tmp;
    await writeFile(join(tmp, 'a.dng'), Buffer.alloc(8));
  });

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    tmp = null;
    live?.close();
    live = null;
  });

  it('returns ETag on 200', async () => {
    const app = new Elysia().use(fakeAuth()).use(fsRoutes);
    const res = await app.handle(
      new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(tmp!)}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toMatch(/^"[a-f0-9]+"$/);
  });

  it('returns 304 when If-None-Match matches', async () => {
    const app = new Elysia().use(fakeAuth()).use(fsRoutes);
    const first = await app.handle(
      new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(tmp!)}`),
    );
    const etag = first.headers.get('ETag')!;
    const second = await app.handle(
      new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(tmp!)}`, {
        headers: { 'If-None-Match': etag },
      }),
    );
    expect(second.status).toBe(304);
  });

  it('returns 200 with a new ETag when contents change', async () => {
    const app = new Elysia().use(fakeAuth()).use(fsRoutes);
    const first = await app.handle(
      new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(tmp!)}`),
    );
    const etag1 = first.headers.get('ETag')!;
    await writeFile(join(tmp!, 'b.dng'), Buffer.alloc(8));
    const second = await app.handle(
      new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(tmp!)}`, {
        headers: { 'If-None-Match': etag1 },
      }),
    );
    expect(second.status).toBe(200);
    expect(second.headers.get('ETag')).not.toBe(etag1);
  });
});
