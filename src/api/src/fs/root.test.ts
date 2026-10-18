import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
// Temp-only symlink fixtures intentionally bypass durable mirrored product I/O.
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, parse, sep } from 'node:path';
import {
  checkAllowed,
  getRegisteredRoots,
  registerRoot,
  safeReadFile,
  safeWriteAllowed,
  unregisterRoot,
} from './root.ts';
import { createLiveTestDatabase, insertFolder } from '../db/sqlite/test-sqlite.test-helpers.ts';
import type { SqlParams, SqlRow } from '../db/sqlite/protocol.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { clearMirrorRoots, setMirrorRoots } from './mirror-registry.ts';
import { benchedMirrors, resetMirrorHealth } from './mirror-read.ts';

let originalRoots: string | undefined;
const temporaryRoots: string[] = [];

beforeEach(() => {
  originalRoots = process.env.MAPLE_ROOTS;
});

afterEach(async () => {
  if (originalRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = originalRoots;
  for (const root of temporaryRoots) unregisterRoot(root);
  clearMirrorRoots();
  resetMirrorHealth();
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('DB libraries and enabled mirrors bound the default filesystem jail', async () => {
  using live = await createLiveTestDatabase('file');
  const fixture = await mkdtemp(join(tmpdir(), 'maple-root-library-'));
  temporaryRoots.push(fixture);
  const library = join(fixture, 'library');
  const retained = join(fixture, 'retained');
  const mirror = join(fixture, 'mirror');
  const outside = join(fixture, 'outside');
  await Promise.all([mkdir(library), mkdir(retained), mkdir(mirror), mkdir(outside)]);
  await Promise.all([
    writeFile(join(library, 'photo.xmp'), '<xmpmeta/>'),
    writeFile(join(mirror, 'photo.xmp'), '<xmpmeta/>'),
    writeFile(join(outside, 'photo.xmp'), '<xmpmeta/>'),
  ]);
  await symlink(join(outside, 'photo.xmp'), join(library, 'escaped.xmp'));
  delete process.env.MAPLE_ROOTS;
  const libraryId = insertFolder(live.db, { path: library });
  invalidateLibraryRoots();

  expect((await safeReadFile(join(library, 'photo.xmp'))).data?.toString()).toBe('<xmpmeta/>');
  expect((await safeWriteAllowed(join(library, 'new.xmp'))).ok).toBe(true);
  expect((await safeReadFile(join(outside, 'photo.xmp'))).ok).toBe(false);
  expect((await safeWriteAllowed(join(outside, 'new.xmp'))).ok).toBe(false);
  expect((await safeReadFile(join(library, 'escaped.xmp'))).ok).toBe(false);
  expect((await checkAllowed(join(mirror, 'photo.xmp'))).ok).toBe(false);

  setMirrorRoots({ [library]: [mirror] });
  expect((await checkAllowed(join(mirror, 'photo.xmp'))).ok).toBe(true);
  // A controlled unresolved realpath stands in for a wedged mirror mount.
  let releaseProbe!: () => void;
  const blocked = new Promise<void>((resolve) => (releaseProbe = resolve));
  const actualRealpath = nodeFs.realpath.bind(nodeFs);
  const mirrorSidecar = join(mirror, 'photo.xmp');
  const realpathProbe = spyOn(nodeFs, 'realpath').mockImplementation(
    (async (requested: Parameters<typeof nodeFs.realpath>[0]) => {
      if (requested === mirror || requested === mirrorSidecar) await blocked;
      return actualRealpath(requested);
    }) as typeof nodeFs.realpath,
  );
  setMirrorRoots({ [library]: [mirror] });
  try {
    const primary = await Promise.race([
      Promise.all([
        safeReadFile(join(library, 'photo.xmp')),
        safeWriteAllowed(join(library, 'new.xmp')),
      ]),
      Bun.sleep(100).then(() => null),
    ]);
    expect(primary?.[0].data?.toString()).toBe('<xmpmeta/>');
    expect(primary?.[1].ok).toBe(true);
    const bounded = (target: string) =>
      Promise.race([checkAllowed(target), Bun.sleep(2_600).then(() => null)]);
    const denied = await bounded(join(outside, 'photo.xmp'));
    expect(denied?.ok).toBe(false);
    expect(benchedMirrors().map(({ root }) => root)).toContain(mirror);
    resetMirrorHealth();
    const mirrorDenied = await bounded(mirrorSidecar);
    expect(mirrorDenied?.ok).toBe(false);
  } finally {
    releaseProbe();
    realpathProbe.mockRestore();
  }
  const slowPrimary = spyOn(nodeFs, 'realpath').mockImplementation(
    (async (requested: Parameters<typeof nodeFs.realpath>[0]) => {
      if (requested === join(library, 'photo.xmp')) await Bun.sleep(2_100);
      return actualRealpath(requested);
    }) as typeof nodeFs.realpath,
  );
  try {
    expect((await safeReadFile(join(library, 'photo.xmp'))).data?.toString()).toBe('<xmpmeta/>');
  } finally {
    slowPrimary.mockRestore();
  }
  clearMirrorRoots();
  expect((await checkAllowed(join(mirror, 'photo.xmp'))).ok).toBe(false);

  insertFolder(live.db, { path: retained });
  invalidateLibraryRoots();
  live.db.query('DELETE FROM folders WHERE id = ?').run(libraryId);
  invalidateLibraryRoots();
  expect((await checkAllowed(join(library, 'photo.xmp'))).ok).toBe(false);
});

test('an unrelated stalled library does not delay a healthy sidecar read', async () => {
  using live = await createLiveTestDatabase('file');
  const fixture = await mkdtemp(join(tmpdir(), 'maple-root-stalled-library-'));
  temporaryRoots.push(fixture);
  const healthy = join(fixture, 'healthy');
  const stalled = join(fixture, 'stalled');
  const alias = join(fixture, 'healthy-alias');
  await Promise.all([mkdir(healthy), mkdir(stalled)]);
  await writeFile(join(healthy, 'photo.xmp'), '<xmpmeta/>');
  delete process.env.MAPLE_ROOTS;
  const healthyId = insertFolder(live.db, { path: healthy });
  insertFolder(live.db, { path: stalled });
  invalidateLibraryRoots();
  let releaseProbe!: () => void;
  let slowAlias = false;
  const blocked = new Promise<void>((resolve) => (releaseProbe = resolve));
  const actualRealpath = nodeFs.realpath.bind(nodeFs);
  const probe = spyOn(nodeFs, 'realpath').mockImplementation(
    (async (requested: Parameters<typeof nodeFs.realpath>[0]) => {
      if (requested === stalled) await blocked;
      if (requested === alias && slowAlias) await Bun.sleep(2_100);
      return actualRealpath(requested);
    }) as typeof nodeFs.realpath,
  );
  try {
    const read = await Promise.race([
      safeReadFile(join(healthy, 'photo.xmp')),
      Bun.sleep(100).then(() => null),
    ]);
    expect(read?.data?.toString()).toBe('<xmpmeta/>');
    await symlink(healthy, alias);
    insertFolder(live.db, { path: alias });
    live.db.query('DELETE FROM folders WHERE id = ?').run(healthyId);
    invalidateLibraryRoots();
    const viaAlias = await Promise.race([
      safeReadFile(join(healthy, 'photo.xmp')),
      Bun.sleep(100).then(() => null),
    ]);
    expect(viaAlias?.data?.toString()).toBe('<xmpmeta/>');
    slowAlias = true;
    expect((await safeWriteAllowed(join(alias, 'new.xmp'))).ok).toBe(true);
  } finally {
    releaseProbe();
    probe.mockRestore();
  }
});

test('an empty registered library remains usable for first-run setup', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'maple-root-first-run-'));
  temporaryRoots.push(fixture);
  const env = { ...process.env };
  delete env.MAPLE_ROOTS;
  // Other suites may retain runtime roots; first-run means none exist at all.
  const script = `
    import { createLiveTestDatabase } from ${JSON.stringify(new URL('../db/sqlite/test-sqlite.test-helpers.ts', import.meta.url).href)};
    import { checkAllowed, getRegisteredRoots } from ${JSON.stringify(new URL('./root.ts', import.meta.url).href)};
    using live = await createLiveTestDatabase();
    const count = live.db.query('SELECT COUNT(*) AS count FROM folders').get().count;
    console.log(JSON.stringify({ count, roots: getRegisteredRoots(), result: await checkAllowed(${JSON.stringify(fixture)}) }));
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  const outcome = JSON.parse(stdout);
  expect(outcome.count).toBe(0);
  expect(outcome.roots).toEqual([]);
  expect(outcome.result.ok).toBe(true);
});

test('a pre-registration empty lookup cannot reopen the jail after library registration', async () => {
  using live = await createLiveTestDatabase();
  const fixture = await mkdtemp(join(tmpdir(), 'maple-root-registration-race-'));
  temporaryRoots.push(fixture);
  const library = join(fixture, 'library');
  const outside = join(fixture, 'outside.xmp');
  await mkdir(library);
  await writeFile(outside, '<xmpmeta/>');
  delete process.env.MAPLE_ROOTS;

  let signalRead!: () => void;
  let releaseRead!: () => void;
  const readStarted = new Promise<void>((resolve) => (signalRead = resolve));
  const readReleased = new Promise<void>((resolve) => (releaseRead = resolve));
  const actualRead = live.handle.read.bind(live.handle);
  const delayedRead = spyOn(live.handle, 'read').mockImplementation(
    async <T = SqlRow>(sql: string, params?: SqlParams): Promise<T[]> => {
      const rows = await actualRead<T>(sql, params);
      if (sql.includes('SELECT id, path, slug, label FROM folders')) {
        signalRead();
        await readReleased;
      }
      return rows;
    },
  );
  try {
    const pending = checkAllowed(outside);
    await readStarted;
    insertFolder(live.db, { path: library });
    invalidateLibraryRoots();
    releaseRead();

    expect((await pending).ok).toBe(false);
    expect((await checkAllowed(outside)).ok).toBe(false);
  } finally {
    releaseRead();
    delayedRead.mockRestore();
  }
});

describe('safeWriteAllowed', () => {
  test('fails closed with MAPLE_ROOTS unset before the database is available', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'maple-root-unconfigured-'));
    temporaryRoots.push(fixture);
    const target = join(fixture, 'photo.xmp');
    const env = { ...process.env };
    delete env.MAPLE_ROOTS;
    // A new process guarantees a cold cache and no roots registered by other
    // suites. Clearing MAPLE_ROOTS alone cannot reset those module singletons.
    const script = `
      import { getRegisteredRoots, safeWriteAllowed } from ${JSON.stringify(new URL('./root.ts', import.meta.url).href)};
      console.log(JSON.stringify({ roots: getRegisteredRoots(), result: await safeWriteAllowed(${JSON.stringify(target)}) }));
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const outcome = JSON.parse(stdout);
    expect(outcome.roots).toEqual([]);
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error).toContain('Cannot load registered library roots');
  });

  test('honors a registered root with MAPLE_ROOTS unset', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'maple-root-registered-'));
    temporaryRoots.push(fixture);
    delete process.env.MAPLE_ROOTS;
    registerRoot(fixture);
    expect(getRegisteredRoots()).toContain(await realpath(fixture));
    const target = join(fixture, 'photo.xmp');

    expect(await safeWriteAllowed(target)).toEqual({
      ok: true,
      data: join(await realpath(fixture), 'photo.xmp'),
    });
  });

  test('normalizes symlinked MAPLE_ROOTS before authorizing a new sidecar', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'maple-root-alias-'));
    temporaryRoots.push(fixture);
    const realRoot = join(fixture, 'real');
    const configuredRoot = join(fixture, 'configured');
    await mkdir(realRoot);
    await symlink(realRoot, configuredRoot);
    process.env.MAPLE_ROOTS = configuredRoot;

    expect(await safeWriteAllowed(join(realRoot, 'photo.xmp'))).toEqual({
      ok: true,
      data: join(await realpath(realRoot), 'photo.xmp'),
    });
    expect(await safeWriteAllowed(join(configuredRoot, 'photo.xmp'))).toEqual({
      ok: true,
      data: join(await realpath(realRoot), 'photo.xmp'),
    });
  });

  test('allows descendants when MAPLE_ROOTS is the filesystem root', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'maple-root-filesystem-'));
    temporaryRoots.push(fixture);
    process.env.MAPLE_ROOTS = parse(fixture).root;

    expect(await safeWriteAllowed(join(fixture, 'photo.xmp'))).toEqual({
      ok: true,
      data: join(await realpath(fixture), 'photo.xmp'),
    });
  });

  test('rejects terminal dot components before constructing a write destination', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'maple-root-traversal-'));
    temporaryRoots.push(fixture);
    const allowedRoot = join(fixture, 'allowed');
    await mkdir(allowedRoot);
    process.env.MAPLE_ROOTS = allowedRoot;

    // Keep the literal terminal component: path.join would normalize it away
    // before the authorization function sees the caller's input.
    for (const suffix of ['.', `.${sep}`, '..', `..${sep}`]) {
      const result = await safeWriteAllowed(`${allowedRoot}${sep}${suffix}`);
      expect(result.ok).toBe(false);
      expect(result.data).toBeUndefined();
    }
  });

  test('rejects a sidecar symlink that points outside its permitted directory', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'maple-root-sidecar-link-'));
    temporaryRoots.push(fixture);
    const allowedRoot = join(fixture, 'allowed');
    const outside = join(fixture, 'outside.xmp');
    await mkdir(allowedRoot);
    await writeFile(outside, '<xmpmeta/>');
    await symlink(outside, join(allowedRoot, 'photo.xmp'));
    process.env.MAPLE_ROOTS = allowedRoot;

    const result = await safeWriteAllowed(join(allowedRoot, 'photo.xmp'));
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
  });

  test('rejects a write whose missing parent sits under an escaping directory symlink (#4748)', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-root-missing-escape-')));
    temporaryRoots.push(fixture);
    const allowedRoot = join(fixture, 'allowed');
    const outside = join(fixture, 'outside');
    await mkdir(allowedRoot);
    await mkdir(outside);
    await symlink(outside, join(allowedRoot, 'escape'));
    process.env.MAPLE_ROOTS = allowedRoot;

    const target = join(allowedRoot, 'escape', 'new-dir', 'photo.xmp');
    expect((await safeWriteAllowed(target)).ok).toBe(false);
    const direct = await checkAllowed(join(allowedRoot, 'escape', 'new-dir'));
    expect(direct.ok).toBe(false);
  });

  test('resolves a missing path through an in-root directory symlink to its real location (#4748)', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-root-missing-inside-')));
    temporaryRoots.push(fixture);
    await mkdir(join(fixture, 'real'));
    await symlink(join(fixture, 'real'), join(fixture, 'alias'));
    process.env.MAPLE_ROOTS = fixture;

    expect(await checkAllowed(join(fixture, 'alias', 'new-dir', 'photo.xmp'))).toEqual({
      ok: true,
      data: join(fixture, 'real', 'new-dir', 'photo.xmp'),
    });
  });

  test('resolves a permitted sidecar symlink to its target', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-root-sidecar-target-')));
    temporaryRoots.push(fixture);
    await mkdir(join(fixture, 'edits'));
    await writeFile(join(fixture, 'edits', 'shared.xmp'), '<xmpmeta/>');
    await symlink(join('edits', 'shared.xmp'), join(fixture, 'photo.xmp'));
    process.env.MAPLE_ROOTS = fixture;

    expect(await safeWriteAllowed(join(fixture, 'photo.xmp'))).toEqual({
      ok: true,
      data: join(fixture, 'edits', 'shared.xmp'),
    });
  });

  test('keeps a live filename ending with the unlinked-inode suffix', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-root-deleted-name-')));
    temporaryRoots.push(fixture);
    const sidecar = join(fixture, 'photo.xmp (deleted)');
    await writeFile(sidecar, '<xmpmeta/>');
    process.env.MAPLE_ROOTS = fixture;

    expect(await safeWriteAllowed(sidecar)).toEqual({ ok: true, data: sidecar });
  });

  test('keeps one destination while atomic saves replace the sidecar (#4051)', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-root-replaced-')));
    temporaryRoots.push(fixture);
    const sidecar = join(fixture, 'photo.xmp');
    const decoy = `${sidecar} (deleted)`;
    await writeFile(sidecar, '<xmpmeta/>');
    await writeFile(decoy, '<decoy/>');
    process.env.MAPLE_ROOTS = fixture;

    const destinations = new Set<string | undefined>();
    let replacing = true;
    const replace = async (round: number): Promise<void> => {
      if (!replacing) return;
      const temp = `${sidecar}.tmp.${round}`;
      await writeFile(temp, `<xmpmeta round="${round}"/>`);
      await rename(temp, sidecar);
      return replace(round + 1);
    };
    const authorize = async (remaining: number): Promise<void> => {
      if (remaining === 0) {
        replacing = false;
        return;
      }
      destinations.add((await safeWriteAllowed(sidecar)).data);
      return authorize(remaining - 1);
    };
    await Promise.all([authorize(5000), replace(0)]);

    expect([...destinations]).toEqual([sidecar]);
    expect(await readFile(decoy, 'utf8')).toBe('<decoy/>');
  });

  test('authorizes every root in the native platform path list', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'maple-root-list-'));
    temporaryRoots.push(fixture);
    const roots = [join(fixture, 'first'), join(fixture, 'second')];
    await Promise.all(roots.map((root) => mkdir(root)));
    process.env.MAPLE_ROOTS = roots.join(delimiter);

    for (const root of roots) {
      expect(await safeWriteAllowed(join(root, 'photo.xmp'))).toEqual({
        ok: true,
        data: join(await realpath(root), 'photo.xmp'),
      });
    }
    expect((await safeWriteAllowed(join(fixture, 'outside.xmp'))).ok).toBe(false);
  });

  test('denies every concurrent write while MAPLE_ROOTS normalization is in flight', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'maple-root-concurrency-'));
    temporaryRoots.push(fixture);
    const allowedRoot = join(fixture, 'allowed');
    const outsideRoot = join(fixture, 'outside');
    await Promise.all([mkdir(allowedRoot), mkdir(outsideRoot)]);
    process.env.MAPLE_ROOTS = allowedRoot;

    const outcomes = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        safeWriteAllowed(join(outsideRoot, `photo-${index}.xmp`)),
      ),
    );

    expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
  });
});
