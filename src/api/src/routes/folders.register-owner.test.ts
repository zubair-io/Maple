import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { safeWriteAllowed } from '../fs/root.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { foldersRoutes } from './folders.ts';

describe('POST /api/folders is owner-only (#5631)', () => {
  let live: LiveTestDatabase;
  let directory = '';
  let savedRoots: string | undefined;

  beforeEach(async () => {
    savedRoots = process.env.MAPLE_ROOTS;
    delete process.env.MAPLE_ROOTS;
    live = await createLiveTestDatabase();
    invalidateLibraryRoots();
    directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-register-owner-')));
  });

  afterEach(async () => {
    live.close();
    invalidateLibraryRoots();
    if (savedRoots === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = savedRoots;
    await rm(directory, { recursive: true, force: true });
  });

  const register = (role: 'owner' | 'member') =>
    new Elysia()
      .use(fakeAuth({ role }))
      .use(foldersRoutes)
      .handle(
        new Request('http://localhost/api/folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: directory }),
        }),
      );

  it('rejects a member with file access and leaves the jail unchanged', async () => {
    const res = await register('member');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'owner role required' });
    expect((await safeWriteAllowed(join(directory, 'x.xmp'))).ok).toBe(false);
  });

  it('registers the directory for an owner', async () => {
    const res = await register('owner');

    expect(res.status).toBe(201);
    expect((await safeWriteAllowed(join(directory, 'x.xmp'))).ok).toBe(true);
  });
});
