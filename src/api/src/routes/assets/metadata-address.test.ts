import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from '../../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { metadataRoutes } from './metadata.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { registerLibrary, seedRouteAsset } from '../../../tests/helpers/assets-route-fixtures.ts';
import { BackupRepository } from '../../cloud-backup/repository.ts';

describe('asset metadata address routes against the live catalogue', () => {
  let live: LiveTestDatabase;
  let root: string;
  let libraryRoot: string;
  let libraryId: string;
  let assetId: string;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    root = await realpath(await mkdtemp(join(tmpdir(), 'maple-metadata-address-')));
    libraryRoot = join(root, 'library');
    await mkdir(join(libraryRoot, 'photos'), { recursive: true });
    await writeFile(join(libraryRoot, 'photos', 'indexed.jpg'), 'original bytes');
    await writeFile(join(libraryRoot, 'unindexed.jpg'), 'unindexed original');
    await writeFile(join(root, 'outside.jpg'), 'outside original');
    await symlink(join(root, 'outside.jpg'), join(libraryRoot, 'escape.jpg'));
    libraryId = registerLibrary(live.db, libraryRoot, 'photos');
    assetId = seedRouteAsset(live.db, {
      libraryId,
      path: 'photos',
      filename: 'indexed.jpg',
    });
  });

  afterEach(async () => {
    invalidateLibraryRoots();
    live.close();
    await rm(root, { recursive: true, force: true });
  });

  function request(route: string, value?: string): Promise<Response> {
    const url = new URL(`http://localhost/api/assets/${route}`);
    if (value !== undefined)
      url.searchParams.set(route === 'by-address' ? 'address' : 'path', value);
    return new Elysia({ prefix: '/api/assets' }).use(metadataRoutes).handle(new Request(url));
  }

  it('returns the same indexed asset through both address forms', async () => {
    const byAddress = await request('by-address', 'photos:photos/indexed.jpg');
    const byPath = await request('by-fspath', join(libraryRoot, 'photos', 'indexed.jpg'));
    expect(byAddress.status).toBe(200);
    expect(byPath.status).toBe(200);
    const addressBody = await byAddress.json();
    const pathBody = await byPath.json();
    expect(addressBody.id).toBe(assetId);
    expect(pathBody.id).toBe(assetId);
    expect(pathBody.address).toBe('photos:photos/indexed.jpg');
  });

  it('includes database-backed mirror state on the asset detail object', async () => {
    const repo = new BackupRepository(live.handle);
    const destination = await repo.createDestination({
      libraryId,
      kind: 'google-drive',
      name: 'Drive',
      path: null,
    });
    await repo.updateDestination(destination.id, { enabled: true });
    const entry = await repo.ensureEntry(destination.id, assetId, 0, 'photos/indexed.jpg');
    await repo.db.write('UPDATE backup_entries SET verified_sequence=sequence WHERE id=?', [
      entry.id,
    ]);

    const response = await request(assetId);
    expect(response.status).toBe(200);
    expect((await response.json()).mirrors).toMatchObject([
      {
        destinationId: destination.id,
        destinationName: 'Drive',
        provider: 'google-drive',
        path: 'photos/indexed.jpg',
        status: 'synced',
        state: 'active',
        lastError: null,
      },
    ]);
  });

  it('includes database-backed mirror state in batch metadata responses', async () => {
    const repo = new BackupRepository(live.handle);
    const destination = await repo.createDestination({
      libraryId,
      kind: 'google-drive',
      name: 'Drive',
      path: null,
    });
    await repo.updateDestination(destination.id, { enabled: true });
    await repo.ensureEntry(destination.id, assetId, 0, 'photos/indexed.jpg');
    const response = await new Elysia({ prefix: '/api/assets' }).use(metadataRoutes).handle(
      new Request('http://localhost/api/assets/batch-meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [assetId] }),
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).assets[0].mirrors).toMatchObject([
      {
        destinationId: destination.id,
        destinationName: 'Drive',
        provider: 'google-drive',
        path: 'photos/indexed.jpg',
        status: 'pending',
      },
    ]);
  });

  it('rejects missing values before resolving a library', async () => {
    for (const route of ['by-address', 'by-fspath']) {
      expect((await request(route)).status).toBe(400);
      expect((await request(route, '')).status).toBe(400);
    }
  });

  it('rejects malformed addresses, unknown libraries, traversal and symlink escapes', async () => {
    for (const address of [
      'malformed',
      ':indexed.jpg',
      'photos:../outside.jpg',
      'photos:escape.jpg',
    ]) {
      expect((await request('by-address', address)).status).toBe(400);
    }
    expect((await request('by-address', 'missing:indexed.jpg')).status).toBe(404);
    expect((await request('by-address', 'photos:missing.jpg')).status).toBe(404);
  });

  it('distinguishes files outside a library from files not indexed yet', async () => {
    for (const absolutePath of [
      libraryRoot,
      join(root, 'outside.jpg'),
      join(root, 'unknown.jpg'),
    ]) {
      const response = await request('by-fspath', absolutePath);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'Path not in any library',
      });
    }
    for (const [route, value] of [
      ['by-address', 'photos:unindexed.jpg'],
      ['by-fspath', join(libraryRoot, 'unindexed.jpg')],
    ]) {
      const response = await request(route, value);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Asset not indexed' });
    }
  });
});
