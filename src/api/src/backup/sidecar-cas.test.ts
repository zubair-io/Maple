/**
 * Hooks around the compare-and-swap publish (#5021): a precondition checked
 * inside the sidecar write barrier can abandon the write, and work that must
 * not interleave with another publish runs inside the same barrier after it.
 * Real files in a registered temp library.
 */
import { expect, test } from 'bun:test';
import realFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as fs from '../fs/mirrored.ts';
import { clearMirrorRoots, setMirrorRoots } from '../fs/mirror-registry.ts';
import {
  createLiveTestDatabase,
  createTempLibrary,
  insertFolder,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { publishSidecarCas, publishSidecarIfAbsent } from './sidecar-cas.ts';

/** These sends never meet a shared sidecar or a kept send. */
const noLedger = {
  keepAside: async () => undefined,
  sentFor: async () => [],
  recordSent: async () => undefined,
};
const noBase = { kind: 'digest', sha256: null } as const;
const edit = (label: string) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Version="${label}"/></rdf:RDF></x:xmpmeta>`;

test('a precondition that no longer holds abandons the write', async () => {
  using library = await createTempLibrary('maple-cas-hooks-');
  const sidecar = path.join(library.root, 'IMG.xmp');
  await fs.writeFile(sidecar, edit('current'));

  const outcome = await publishSidecarCas(sidecar, edit('stale'), noBase, noLedger, library.root, {
    precondition: async () => false,
  });

  expect(outcome).toEqual({ kind: 'abandoned' });
  expect(await fs.readFile(sidecar, 'utf8')).toBe(edit('current'));
});

test('the after-landing hook sees the published sidecar before the next publish runs', async () => {
  using library = await createTempLibrary('maple-cas-hooks-');
  const sidecar = path.join(library.root, 'IMG.xmp');
  const seen: string[] = [];

  const first = publishSidecarCas(sidecar, edit('first'), noBase, noLedger, library.root, {
    afterLanded: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      seen.push(await fs.readFile(sidecar, 'utf8'));
    },
  });
  const second = publishSidecarCas(sidecar, edit('second'), noBase, noLedger, library.root);
  await Promise.all([first, second]);

  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain('crs:Version="first"');
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
    const outcome = await publishSidecarCas(
      sidecar,
      edit('mirrored'),
      noBase,
      noLedger,
      linkedRoot,
    );
    await fs.flushPendingMirrorOps();

    expect(outcome.kind).toBe('written');
    const mirrored = await fs.readFile(path.join(mirror, '2026', '10', 'x.xmp'), 'utf8');
    expect(mirrored).toBe(await fs.readFile(sidecar, 'utf8'));
    expect(mirrored).toContain('crs:Version="mirrored"');
  } finally {
    clearMirrorRoots();
    live.close();
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test('a library root retargeted after the comparison fails closed instead of writing into another library (#5027)', async () => {
  // A declared root covering the temp dir would legitimately allow the write (#5483).
  const inheritedRoots = process.env.MAPLE_ROOTS;
  delete process.env.MAPLE_ROOTS;
  const live = await createLiveTestDatabase();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-cas-retarget-'));
  try {
    const realRoot = path.join(scratch, 'real-library');
    const otherRoot = path.join(scratch, 'other-library');
    const linkedRoot = path.join(scratch, 'linked-library');
    const mirror = path.join(scratch, 'mirror');
    await Promise.all(
      [realRoot, otherRoot, mirror].map((dir) => fs.mkdir(dir, { recursive: true })),
    );
    await fs.symlink(realRoot, linkedRoot);
    insertFolder(live.db, { path: linkedRoot });
    insertFolder(live.db, { path: otherRoot });
    setMirrorRoots({ [linkedRoot]: [mirror] });

    const outcome = await publishSidecarCas(
      path.join(linkedRoot, 'x.xmp'),
      edit('retargeted'),
      noBase,
      noLedger,
      linkedRoot,
      {
        beforeWrite: async () => {
          await realFs.rm(linkedRoot);
          await realFs.symlink(otherRoot, linkedRoot);
        },
      },
    );
    await fs.flushPendingMirrorOps();

    await expect(fs.access(path.join(otherRoot, 'x.xmp'))).rejects.toThrow();
    await expect(fs.access(path.join(mirror, 'x.xmp'))).rejects.toThrow();
    expect(outcome.kind).toBe('error');
  } finally {
    if (inheritedRoots !== undefined) process.env.MAPLE_ROOTS = inheritedRoots;
    clearMirrorRoots();
    live.close();
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test('a legacy create-only sidecar in a symlinked-root library replicates to its mirror (#5027)', async () => {
  const live = await createLiveTestDatabase();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-cas-legacy-'));
  try {
    const realRoot = path.join(scratch, 'real-library');
    const linkedRoot = path.join(scratch, 'linked-library');
    const mirror = path.join(scratch, 'mirror');
    await fs.mkdir(realRoot, { recursive: true });
    await fs.mkdir(mirror, { recursive: true });
    await fs.symlink(realRoot, linkedRoot);
    insertFolder(live.db, { path: linkedRoot });
    setMirrorRoots({ [linkedRoot]: [mirror] });

    const outcome = await publishSidecarIfAbsent(
      path.join(linkedRoot, '2026', 'y.xmp'),
      '<legacy/>',
      linkedRoot,
      { precondition: async () => true, beforeWrite: async () => undefined },
    );
    await fs.flushPendingMirrorOps();

    expect(outcome).toBe('written');
    expect(await fs.readFile(path.join(mirror, '2026', 'y.xmp'), 'utf8')).toBe('<legacy/>');
  } finally {
    clearMirrorRoots();
    live.close();
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
