/**
 * The path jail fails closed when no roots are known (#4747). A fresh install
 * has none, so registering the first library must not itself depend on the
 * jail, and the jail must admit that library's files as soon as it is added.
 */

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

describe('POST /api/folders — first library on a jail with no roots (#4747)', () => {
  let live: LiveTestDatabase;
  let library = '';
  let savedRoots: string | undefined;

  beforeEach(async () => {
    savedRoots = process.env.MAPLE_ROOTS;
    delete process.env.MAPLE_ROOTS;
    live = await createLiveTestDatabase();
    invalidateLibraryRoots();
    library = await realpath(await mkdtemp(join(tmpdir(), 'maple-first-library-')));
  });

  afterEach(async () => {
    live.close();
    invalidateLibraryRoots();
    if (savedRoots === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = savedRoots;
    await rm(library, { recursive: true, force: true });
  });

  it('registers the first library and then admits writes inside it', async () => {
    const sidecar = join(library, 'IMG_0001.xmp');
    expect((await safeWriteAllowed(sidecar)).ok).toBe(false);

    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    const res = await app.handle(
      new Request('http://localhost/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: library, label: 'First' }),
      }),
    );

    expect(res.status).toBe(201);
    expect(await safeWriteAllowed(sidecar)).toEqual({ ok: true, data: sidecar });
    expect((await safeWriteAllowed(join(tmpdir(), 'elsewhere.xmp'))).ok).toBe(false);
  });
});
