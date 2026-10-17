import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
import { tmpdir } from 'node:os';
import { delimiter, join, parse, sep } from 'node:path';
import {
  checkAllowed,
  getRegisteredRoots,
  registerRoot,
  safeWriteAllowed,
  unregisterRoot,
} from './root.ts';

let originalRoots: string | undefined;
const temporaryRoots: string[] = [];

beforeEach(() => {
  originalRoots = process.env.MAPLE_ROOTS;
});

afterEach(async () => {
  if (originalRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = originalRoots;
  for (const root of temporaryRoots) unregisterRoot(root);
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('safeWriteAllowed', () => {
  test('fails closed when MAPLE_ROOTS is unset and no roots are registered (#4747)', async () => {
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
    const parsed = JSON.parse(stdout) as {
      roots: string[];
      result: { ok: boolean; data?: string; error?: string };
    };
    expect(parsed.roots).toEqual([]);
    expect(parsed.result.ok).toBe(false);
    expect(parsed.result.data).toBeUndefined();
    expect(parsed.result.error).toContain('outside all registered roots');
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
    try {
      await Promise.all([authorize(5000), replace(0)]);
    } finally {
      replacing = false;
    }

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

  test('rejects live and dangling sidecar symlinks escaping a SQLite library root with MAPLE_ROOTS unset (#4747)', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-root-symlink-unset-')));
    temporaryRoots.push(fixture);
    const libraryRoot = join(fixture, 'library');
    const outsideLive = join(fixture, 'outside-live.xmp');
    const outsideDangling = join(fixture, 'outside-dangling.xmp');
    await mkdir(libraryRoot);
    await writeFile(outsideLive, '<xmpmeta/>');
    await symlink(outsideLive, join(libraryRoot, 'live-escape.xmp'));
    await symlink(outsideDangling, join(libraryRoot, 'dangling-escape.xmp'));
    delete process.env.MAPLE_ROOTS;

    const { createLiveTestDatabase, insertFolder } =
      await import('../db/sqlite/test-sqlite.test-helpers.ts');
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    const live = await createLiveTestDatabase();
    try {
      insertFolder(live.db, { path: libraryRoot, slug: 'library' });
      invalidateLibraryRoots();

      expect((await safeWriteAllowed(join(libraryRoot, 'inside.xmp'))).ok).toBe(true);
      expect((await safeWriteAllowed(join(libraryRoot, 'live-escape.xmp'))).ok).toBe(false);
      expect((await safeWriteAllowed(join(libraryRoot, 'dangling-escape.xmp'))).ok).toBe(false);
    } finally {
      live.close();
      invalidateLibraryRoots();
    }
  });

  test('shares SQLite folders jail roots across API and worker processes on startup, add, and remove (#4747)', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-root-shared-proc-')));
    temporaryRoots.push(fixture);
    const libA = join(fixture, 'lib-a');
    const libB = join(fixture, 'lib-b');
    const outside = join(fixture, 'outside');
    await Promise.all([mkdir(libA), mkdir(libB), mkdir(outside)]);

    const { createLiveTestDatabase, insertFolder } =
      await import('../db/sqlite/test-sqlite.test-helpers.ts');
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    delete process.env.MAPLE_ROOTS;
    const live = await createLiveTestDatabase('file');
    try {
      insertFolder(live.db, { path: libA, slug: 'lib-a' });
      invalidateLibraryRoots();

      const env = { ...process.env };
      delete env.MAPLE_ROOTS;
      const rootModuleHref = new URL('./root.ts', import.meta.url).href;
      const sqliteModuleHref = new URL('../db/sqlite/index.ts', import.meta.url).href;
      const cacheModuleHref = new URL('../indexer/libraries.cache.ts', import.meta.url).href;

      const probeWorkerProcess = async (targets: string[]) => {
        const script = `
          import { openSqlitePool, closeSqlitePool } from ${JSON.stringify(sqliteModuleHref)};
          import { safeWriteAllowed } from ${JSON.stringify(rootModuleHref)};
          import { loadLibraryRoots } from ${JSON.stringify(cacheModuleHref)};
          await openSqlitePool({ path: ${JSON.stringify(live.path)}, readers: 1 });
          try {
            const results = {};
            for (const target of ${JSON.stringify(targets)}) {
              results[target] = (await safeWriteAllowed(target)).ok;
            }
            const roots = [...(await loadLibraryRoots()).values()];
            console.log(JSON.stringify({ results, roots }));
          } finally {
            closeSqlitePool();
          }
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
        return JSON.parse(stdout) as { results: Record<string, boolean>; roots: string[] };
      };

      const targetA = join(libA, 'a.xmp');
      const targetB = join(libB, 'b.xmp');
      const targetOutside = join(outside, 'out.xmp');

      // 1. Startup: both API (parent) and worker (child) allow libA and deny libB/outside.
      expect((await safeWriteAllowed(targetA)).ok).toBe(true);
      expect((await safeWriteAllowed(targetB)).ok).toBe(false);
      expect((await safeWriteAllowed(targetOutside)).ok).toBe(false);
      const bootProbe = await probeWorkerProcess([targetA, targetB, targetOutside]);
      expect(bootProbe.results).toEqual({
        [targetA]: true,
        [targetB]: false,
        [targetOutside]: false,
      });
      expect(bootProbe.roots).toEqual([libA]);

      // 2. Add libB in SQLite: both processes authorize libA and libB without registerRoot().
      insertFolder(live.db, { path: libB, slug: 'lib-b' });
      invalidateLibraryRoots();
      expect((await safeWriteAllowed(targetB)).ok).toBe(true);
      const addedProbe = await probeWorkerProcess([targetA, targetB, targetOutside]);
      expect(addedProbe.results).toEqual({
        [targetA]: true,
        [targetB]: true,
        [targetOutside]: false,
      });
      expect(addedProbe.roots.sort()).toEqual([libA, libB].sort());

      // 3. Remove libA from SQLite: both processes deny libA and still allow libB.
      live.db.query('DELETE FROM folders WHERE path = ?').run(libA);
      invalidateLibraryRoots();
      expect((await safeWriteAllowed(targetA)).ok).toBe(false);
      expect((await safeWriteAllowed(targetB)).ok).toBe(true);
      const removedProbe = await probeWorkerProcess([targetA, targetB, targetOutside]);
      expect(removedProbe.results).toEqual({
        [targetA]: false,
        [targetB]: true,
        [targetOutside]: false,
      });
      expect(removedProbe.roots).toEqual([libB]);
    } finally {
      live.close();
      invalidateLibraryRoots();
    }
  });

  test('rejects a dangling sidecar link whose `..` only escapes once an inner symlink is followed (#4747)', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-root-dotdot-link-')));
    temporaryRoots.push(fixture);
    const libraryRoot = join(fixture, 'library');
    const outsideDeep = join(fixture, 'outside', 'deep');
    await mkdir(libraryRoot);
    await mkdir(outsideDeep, { recursive: true });
    await symlink(outsideDeep, join(libraryRoot, 'hop'));
    // Text-only resolution collapses `hop/..` to the library root; the kernel
    // follows `hop` first and lands in `outside/escape.xmp`.
    await symlink(['hop', '..', 'escape.xmp'].join(sep), join(libraryRoot, 'IMG_0001.xmp'));
    delete process.env.MAPLE_ROOTS;
    registerRoot(libraryRoot);
    temporaryRoots.push(libraryRoot);

    expect((await safeWriteAllowed(join(libraryRoot, 'IMG_0002.xmp'))).ok).toBe(true);
    expect((await safeWriteAllowed(join(libraryRoot, 'IMG_0001.xmp'))).ok).toBe(false);
  });

  test('serves library roots from the invalidation-coherent cache, not a query per check (#4747)', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-root-cached-')));
    temporaryRoots.push(fixture);
    delete process.env.MAPLE_ROOTS;

    const { createLiveTestDatabase, insertFolder } =
      await import('../db/sqlite/test-sqlite.test-helpers.ts');
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    const live = await createLiveTestDatabase();
    try {
      insertFolder(live.db, { path: fixture, slug: 'cached' });
      invalidateLibraryRoots();
      const sidecar = join(fixture, 'IMG_0001.xmp');
      expect((await safeWriteAllowed(sidecar)).ok).toBe(true);

      // A folders change nobody announced is invisible: the jail did not re-query.
      live.db.query('DELETE FROM folders WHERE path = ?').run(fixture);
      const checks = await Promise.all(
        Array.from({ length: 50 }, (_, index) => safeWriteAllowed(join(fixture, `${index}.xmp`))),
      );
      expect(checks.every((check) => check.ok)).toBe(true);

      invalidateLibraryRoots();
      expect((await safeWriteAllowed(sidecar)).ok).toBe(false);
    } finally {
      live.close();
      invalidateLibraryRoots();
    }
  });
});
