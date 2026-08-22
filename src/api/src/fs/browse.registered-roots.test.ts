import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { listDirContents } from './browse.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';

const priorRoots = process.env.MAPLE_ROOTS;
const temporaryRoots: string[] = [];

afterEach(async () => {
  setLibraryRootsForTests(null);
  if (priorRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = priorRoots;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('listDirContents registered-library jail', () => {
  test('enumerates a registered library outside MAPLE_ROOTS', async () => {
    const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-fp-root-')));
    temporaryRoots.push(fixture);
    const configured = path.join(fixture, 'configured');
    const library = path.join(fixture, 'photos');
    await Promise.all([mkdir(configured), mkdir(library)]);
    await writeFile(path.join(library, 'photo.jpg'), Buffer.from('fixture'));

    process.env.MAPLE_ROOTS = configured;
    setLibraryRootsForTests(new Map([[new ObjectId().toHexString(), library]]));

    const result = await listDirContents(library, { limit: 500 });

    expect(result.ok).toBe(true);
    expect(result.data?.path).toBe(library);
    expect(result.data?.images.map((image) => image.name)).toEqual(['photo.jpg']);
  });

  test('still rejects paths outside MAPLE_ROOTS and every registered library', async () => {
    const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-fp-jail-')));
    temporaryRoots.push(fixture);
    const configured = path.join(fixture, 'configured');
    const library = path.join(fixture, 'photos');
    const outside = path.join(fixture, 'outside');
    await Promise.all([mkdir(configured), mkdir(library), mkdir(outside)]);

    process.env.MAPLE_ROOTS = configured;
    setLibraryRootsForTests(new Map([[new ObjectId().toHexString(), library]]));

    const result = await listDirContents(outside, { limit: 500 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside MAPLE_ROOTS');
  });
});
