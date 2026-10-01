import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetsRoutes } from './assets.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { registerLibrary, seedRouteAsset } from '../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let root: string;
let assetId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'maple-sidecar-stat-'));
  const libraryId = registerLibrary(live.db, root, 'photos');
  assetId = seedRouteAsset(live.db, {
    libraryId,
    path: '',
    filename: 'photo.dng',
    mtimeMs: 1_000_000,
  });
  await writeFile(join(root, 'photo.dng'), 'original');
});

afterEach(async () => {
  live.close();
  await rm(root, { recursive: true, force: true });
});

describe('asset detail sidecar stat parity', () => {
  for (const lookup of ['id', 'address', 'fspath'] as const) {
    it(`${lookup} returns the current sidecar time and size, or null after deletion`, async () => {
      const app = new Elysia().use(fakeAuth()).use(assetsRoutes);
      const route =
        lookup === 'id'
          ? assetId
          : lookup === 'address'
            ? 'by-address?address=photos%3Aphoto.dng'
            : `by-fspath?path=${encodeURIComponent(join(root, 'photo.dng'))}`;
      const read = async () => {
        const response = await app.handle(new Request(`http://localhost/api/assets/${route}`));
        expect(response.status).toBe(200);
        return (await response.json()) as {
          xmp_mtime: number | null;
          xmp_size: number | null;
        };
      };
      expect(await read()).toMatchObject({ xmp_mtime: null, xmp_size: null });

      const sidecar = join(root, 'photo.xmp');
      for (const [xml, seconds] of [
        ['<x:xmpmeta>first save</x:xmpmeta>', 1_700_000_000],
        ['<x:xmpmeta>later metadata save</x:xmpmeta>', 1_700_000_060],
      ] as const) {
        await writeFile(sidecar, xml);
        await utimes(sidecar, seconds, seconds);
        const actual = await stat(sidecar);
        expect(await read()).toMatchObject({
          xmp_mtime: Math.floor(actual.mtimeMs / 1000),
          xmp_size: actual.size,
        });
      }

      await unlink(sidecar);
      expect(await read()).toMatchObject({ xmp_mtime: null, xmp_size: null });
      expect(await Bun.file(join(root, 'photo.dng')).text()).toBe('original');
    });
  }
});
