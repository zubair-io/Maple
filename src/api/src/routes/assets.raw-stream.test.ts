/** GET /api/assets/:id/raw streams the original instead of buffering it whole. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, writeFile, realpath, symlink } from '../fs/mirrored.ts';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetsRoutes } from './assets.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { newObjectIdHex } from '../db/object-id.ts';
import { registerLibrary, seedRouteAsset } from '../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

describe('GET /api/assets/:id/raw', () => {
  let live: LiveTestDatabase;
  let tmp: string;
  let outside: string;
  let libraryId: string;
  let previousRoots: string | undefined;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-raw-stream-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'maple-raw-outside-')));
    previousRoots = process.env.MAPLE_ROOTS;
    process.env.MAPLE_ROOTS = tmp;
    libraryId = registerLibrary(live.db, tmp);
  });

  afterEach(async () => {
    if (previousRoots === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = previousRoots;
    live.close();
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    await rm(outside, { recursive: true, force: true }).catch(() => {});
  });

  function seed(filename: string, size: number): string {
    return seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename,
      size,
      mapleId: `raw-${newObjectIdHex()}`,
    });
  }

  function get(assetId: string): Promise<Response> {
    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);
    return app.handle(new Request(`http://localhost/api/assets/${assetId}/raw`));
  }

  it('serves the exact original bytes with length and attachment headers', async () => {
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    await writeFile(join(tmp, 'IMG 1.dng'), bytes);
    const res = await get(seed('IMG 1.dng', bytes.byteLength));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Length')).toBe(String(bytes.byteLength));
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('refuses an original that symlinks outside the library', async () => {
    await writeFile(join(outside, 'secret.dng'), 'secret');
    await symlink(join(outside, 'secret.dng'), join(tmp, 'escape.dng'));
    const res = await get(seed('escape.dng', 6));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('secret"');
  });

  it('answers 403 for a catalogued original missing from disk', async () => {
    const res = await get(seed('gone.dng', 10));
    expect(res.status).toBe(403);
  });
});
