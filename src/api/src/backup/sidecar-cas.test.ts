/**
 * Hooks around the compare-and-swap publish (#5021): a precondition checked
 * inside the sidecar write barrier can abandon the write, and work that must
 * not interleave with another publish runs inside the same barrier after it.
 * Real files in a registered temp library.
 */
import { expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import * as fs from '../fs/mirrored.ts';
import { flushPendingMirrorOps } from '../fs/mirrored.ts';
import { clearMirrorRoots, setMirrorRoots } from '../fs/mirror-registry.ts';
import {
  createLiveTestDatabase,
  createTempLibrary,
  insertFolder,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { publishSidecarCas, publishSidecarIfAbsent } from './sidecar-cas.ts';

const keepNothing = async () => async () => undefined;

test('a precondition that no longer holds abandons the write', async () => {
  using library = await createTempLibrary('maple-cas-hooks-');
  const sidecar = path.join(library.root, 'IMG.xmp');
  await fs.writeFile(sidecar, 'current');

  const outcome = await publishSidecarCas(sidecar, 'stale', null, keepNothing, library.root, {
    precondition: async () => false,
  });

  expect(outcome).toEqual({ kind: 'abandoned' });
  expect(await fs.readFile(sidecar, 'utf8')).toBe('current');
});

test('the after-landing hook sees the published sidecar before the next publish runs', async () => {
  using library = await createTempLibrary('maple-cas-hooks-');
  const sidecar = path.join(library.root, 'IMG.xmp');
  const seen: string[] = [];

  const first = publishSidecarCas(sidecar, 'first', null, keepNothing, library.root, {
    afterLanded: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      seen.push(await fs.readFile(sidecar, 'utf8'));
    },
  });
  const second = publishSidecarCas(sidecar, 'second', null, keepNothing, library.root);
  await Promise.all([first, second]);

  expect(seen).toEqual(['first']);
});

test('a create-only publish whose precondition no longer holds writes nothing', async () => {
  using library = await createTempLibrary('maple-cas-hooks-');
  const sidecar = path.join(library.root, 'IMG.xmp');

  const outcome = await publishSidecarIfAbsent(sidecar, 'stale', library.root, {
    precondition: async () => false,
    beforeWrite: async () => undefined,
  });

  expect(outcome).toEqual({ kind: 'abandoned' });
  await expect(fs.access(sidecar)).rejects.toThrow();
});

test('a sidecar published into a library reached through a symlinked root replicates to its mirror (#5027)', async () => {
  const live = await createLiveTestDatabase();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-cas-symlink-'));
  try {
    const realRoot = path.join(scratch, 'real-library');
    const linkedRoot = path.join(scratch, 'linked-library');
    const mirror = path.join(scratch, 'mirror');
    await fs.mkdir(realRoot, { recursive: true });
    await fs.mkdir(mirror, { recursive: true });
    await fs.symlink(realRoot, linkedRoot);
    insertFolder(live.db, { path: linkedRoot });
    setMirrorRoots({ [linkedRoot]: [mirror] });

    const sidecar = path.join(linkedRoot, '2026', '10', 'x.xmp');
    const outcome = await publishSidecarCas(sidecar, '<xmp/>', null, keepNothing, linkedRoot);
    await flushPendingMirrorOps();

    expect(outcome).toEqual({ kind: 'written' });
    expect(await fs.readFile(path.join(mirror, '2026', '10', 'x.xmp'), 'utf8')).toBe('<xmp/>');
  } finally {
    clearMirrorRoots();
    live.close();
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
