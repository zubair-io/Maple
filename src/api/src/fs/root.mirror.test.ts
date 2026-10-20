import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
// Temp-only symlink fixtures intentionally bypass durable mirrored product I/O.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  checkAllowed,
  getRegisteredRoots,
  registerRoot,
  safeReadFile,
  safeWriteAllowed,
  unregisterRoot,
} from './root.ts';
import { clearMirrorRoots, mirrorGeneration, setMirrorRoots } from './mirror-registry.ts';
import { createLiveTestDatabase, insertFolder } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';

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
  invalidateLibraryRoots();
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('an unregistered SQLite primary remains usable when mirrors are enabled', async () => {
  using live = await createLiveTestDatabase('file');
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-mirror-primary-')));
  temporaryRoots.push(fixture);
  const primary = join(fixture, 'primary');
  const mirror = join(fixture, 'mirror');
  const stalled = join(fixture, 'stalled');
  const alias = join(fixture, 'primary-alias');
  await Promise.all([mkdir(primary), mkdir(mirror), mkdir(stalled)]);
  await writeFile(join(primary, 'photo.xmp'), '<xmpmeta/>');
  insertFolder(live.db, { path: primary });
  invalidateLibraryRoots();
  delete process.env.MAPLE_ROOTS;
  expect(getRegisteredRoots()).not.toContain(primary);
  setMirrorRoots({ [primary]: [stalled, mirror] });

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const actualRealpath = nodeFs.realpath.bind(nodeFs);
  let delayAlias = false;
  const probe = spyOn(nodeFs, 'realpath').mockImplementation((async (
    requested: Parameters<typeof nodeFs.realpath>[0],
  ) => {
    if (requested === stalled) await held;
    if (requested === alias && delayAlias) {
      delayAlias = false;
      await Bun.sleep(2_100);
    }
    return actualRealpath(requested);
  }) as typeof nodeFs.realpath);
  const within = <T>(work: Promise<T>, ms = 500) =>
    Promise.race([work, Bun.sleep(ms).then(() => null)]);
  try {
    expect((await within(safeReadFile(join(primary, 'photo.xmp'))))?.data?.toString()).toBe(
      '<xmpmeta/>',
    );
    const write = await within(safeWriteAllowed(join(primary, 'new.xmp')));
    expect(write?.ok).toBe(true);
    await writeFile(write!.data!, '<xmpmeta new="true"/>');
    expect((await safeReadFile(join(primary, 'new.xmp'))).data?.toString()).toBe(
      '<xmpmeta new="true"/>',
    );
    expect((await checkAllowed(join(fixture, 'outside.xmp'))).ok).toBe(false);
    await symlink(primary, alias);
    setMirrorRoots({ [alias]: [stalled, mirror] });
    delayAlias = true;
    expect((await within(safeReadFile(join(primary, 'photo.xmp')), 2_600))?.ok).toBe(true);
    release();
    const outside = join(fixture, 'secret.xmp');
    await writeFile(outside, '<secret/>');
    await symlink(outside, join(primary, 'escape.xmp'));
    expect((await safeReadFile(join(primary, 'escape.xmp'))).ok).toBe(false);
    expect((await safeWriteAllowed(join(primary, 'escape.xmp'))).ok).toBe(false);
    process.env.MAPLE_ROOTS = mirror;
    expect((await checkAllowed(join(primary, 'photo.xmp'))).ok).toBe(true);
    clearMirrorRoots();
    live.db.query('DELETE FROM folders WHERE path = ?').run(primary);
    invalidateLibraryRoots();
    expect((await checkAllowed(join(primary, 'photo.xmp'))).ok).toBe(false);
  } finally {
    release();
    probe.mockRestore();
  }
}, 10_000);

test('a canonical mirror match is independent of unrelated stalled roots', async () => {
  using live = await createLiveTestDatabase('file');
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-mirror-jail-')));
  temporaryRoots.push(fixture);
  const primary = join(fixture, 'primary');
  const mirror = join(fixture, 'mirror');
  const stalled = join(fixture, 'stalled');
  const alias = join(fixture, 'alias');
  const outside = join(fixture, 'outside');
  await Promise.all([mkdir(primary), mkdir(mirror), mkdir(stalled), mkdir(outside)]);
  await symlink(mirror, alias);
  await writeFile(join(mirror, 'photo.xmp'), '<xmpmeta/>');
  await writeFile(join(outside, 'secret.xmp'), '<secret/>');
  await symlink(join(outside, 'secret.xmp'), join(mirror, 'escape.xmp'));
  insertFolder(live.db, { path: primary });
  invalidateLibraryRoots();
  delete process.env.MAPLE_ROOTS;
  registerRoot(primary);
  setMirrorRoots({ [primary]: [stalled, alias] });

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const actualRealpath = nodeFs.realpath.bind(nodeFs);
  let stalledProbes = 0;
  let releaseAlias!: () => void;
  let heldAlias = new Promise<void>((resolve) => (releaseAlias = resolve));
  let heldAliasProbes = 0;
  let holdAlias = false;
  const probe = spyOn(nodeFs, 'realpath').mockImplementation((async (
    requested: Parameters<typeof nodeFs.realpath>[0],
  ) => {
    if (requested === stalled) {
      stalledProbes++;
      await held;
    }
    if (requested === alias && holdAlias) {
      heldAliasProbes++;
      const oldTarget = await actualRealpath(requested);
      await heldAlias;
      return oldTarget;
    }
    return actualRealpath(requested);
  }) as typeof nodeFs.realpath);
  const within = <T>(work: Promise<T>, ms: number) =>
    Promise.race([work, Bun.sleep(ms).then(() => null)]);
  try {
    const target = join(mirror, 'photo.xmp');
    expect((await within(safeReadFile(target), 500))?.data?.toString()).toBe('<xmpmeta/>');
    const write = await within(safeWriteAllowed(join(mirror, 'new.xmp')), 500);
    expect(write?.ok).toBe(true);
    await writeFile(write!.data!, '<xmpmeta new="true"/>');
    expect((await safeReadFile(join(mirror, 'new.xmp'))).data?.toString()).toBe(
      '<xmpmeta new="true"/>',
    );
    expect((await within(safeReadFile(join(alias, 'photo.xmp')), 500))?.ok).toBe(true);
    expect((await safeReadFile(join(mirror, 'escape.xmp'))).ok).toBe(false);
    expect((await safeWriteAllowed(join(mirror, 'escape.xmp'))).ok).toBe(false);
    expect(stalledProbes).toBeLessThanOrEqual(1);
    await Promise.all(Array.from({ length: 8 }, () => checkAllowed(join(fixture, 'outside.xmp'))));
    expect(stalledProbes).toBe(1);
    const repeated = await within(checkAllowed(join(fixture, 'outside.xmp')), 500);
    expect(repeated?.ok).toBe(false);
    expect(stalledProbes).toBe(1);
    expect((await within(checkAllowed(join(primary, 'photo.xmp')), 500))?.ok).toBe(true);
    expect((await within(checkAllowed(target), 500))?.ok).toBe(true);
    process.env.MAPLE_ROOTS = primary;
    expect((await checkAllowed(target)).ok).toBe(true);
    clearMirrorRoots();
    expect((await checkAllowed(target)).ok).toBe(false);
    setMirrorRoots({ [primary]: [stalled, alias] });
    delete process.env.MAPLE_ROOTS;
    unregisterRoot(primary);
    expect((await checkAllowed(join(outside, 'secret.xmp'))).ok).toBe(false);
    expect((await checkAllowed(target)).ok).toBe(true);
    registerRoot(primary);
    const secondAlias = join(fixture, 'second-alias');
    await symlink(outside, secondAlias);
    setMirrorRoots({ [primary]: [stalled, alias, secondAlias] });
    expect((await checkAllowed(target)).ok).toBe(true);
    await rm(alias);
    await symlink(outside, alias);
    await rm(secondAlias);
    await symlink(mirror, secondAlias);
    holdAlias = true;
    expect((await within(safeReadFile(target), 500))?.data?.toString()).toBe('<xmpmeta/>');
    expect(heldAliasProbes).toBe(1);
    const generation = mirrorGeneration();
    setMirrorRoots({ [primary]: [secondAlias, alias, stalled] });
    expect(mirrorGeneration()).toBe(generation);
    await rm(alias);
    await symlink(mirror, alias);
    setMirrorRoots({ [primary]: [] });
    setMirrorRoots({ [primary]: [stalled, alias, secondAlias] });
    const stale = checkAllowed(join(outside, 'secret.xmp'));
    await Bun.sleep(20);
    releaseAlias();
    expect((await stale).ok).toBe(false);
    expect((await checkAllowed(target)).ok).toBe(true);
    setMirrorRoots({ [primary]: [] });
    expect((await checkAllowed(target)).ok).toBe(false);
    heldAlias = new Promise<void>((resolve) => (releaseAlias = resolve));
    setMirrorRoots({ [primary]: [alias] });
    const pendingRead = safeReadFile(target);
    await Bun.sleep(20);
    expect(heldAliasProbes).toBe(2);
    setMirrorRoots({ [primary]: [alias] });
    const afterReload = safeReadFile(target);
    await Bun.sleep(20);
    expect(heldAliasProbes).toBe(2);
    releaseAlias();
    expect((await pendingRead).data?.toString()).toBe('<xmpmeta/>');
    expect((await afterReload).data?.toString()).toBe('<xmpmeta/>');
    await rm(alias);
    await symlink(outside, alias);
    setMirrorRoots({ [alias]: [stalled] });
    heldAlias = new Promise<void>((resolve) => (releaseAlias = resolve));
    const oldPrimary = checkAllowed(join(outside, 'secret.xmp'));
    await Bun.sleep(20);
    expect(heldAliasProbes).toBe(4);
    await rm(alias);
    await symlink(mirror, alias);
    setMirrorRoots({ [alias]: [] });
    setMirrorRoots({ [alias]: [stalled] });
    const stalePrimary = checkAllowed(join(outside, 'secret.xmp'));
    await Bun.sleep(20);
    expect(heldAliasProbes).toBe(4);
    releaseAlias();
    expect((await stalePrimary).ok).toBe(false);
    expect((await oldPrimary).ok).toBe(false);
    expect((await checkAllowed(target)).ok).toBe(true);
  } finally {
    release();
    releaseAlias();
    probe.mockRestore();
    unregisterRoot(primary);
  }
  expect(getRegisteredRoots()).not.toContain(primary);
}, 10_000);

for (const kind of ['mirror', 'primary'] as const) {
  test.each(['stable', 'retargeted'] as const)(
    `${kind} waiters share successor probes for a %s alias`,
    async (mode) => {
      using _live = await createLiveTestDatabase();
      const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-root-waiters-')));
      temporaryRoots.push(fixture);
      const former = join(fixture, 'former');
      const current = join(fixture, 'current');
      const primary = join(fixture, 'primary');
      const alias = join(fixture, 'alias');
      await Promise.all([mkdir(former), mkdir(current), mkdir(primary)]);
      await Promise.all(
        [former, current].map((root) => writeFile(join(root, 'photo.xmp'), '<xmpmeta/>')),
      );
      await symlink(former, alias);
      delete process.env.MAPLE_ROOTS;
      setMirrorRoots(kind === 'primary' ? { [alias]: [primary] } : { [primary]: [alias] });
      const captured = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
      const held = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
      const actualRealpath = nodeFs.realpath.bind(nodeFs);
      const calls: string[] = [];
      const probe = spyOn(nodeFs, 'realpath').mockImplementation((async (
        requested: Parameters<typeof nodeFs.realpath>[0],
      ) => {
        if (
          requested === primary ||
          requested === join(former, 'photo.xmp') ||
          requested === join(current, 'photo.xmp')
        )
          return requested;
        if (requested !== alias) return actualRealpath(requested);
        const index = calls.push(alias) - 1;
        const target = await actualRealpath(requested);
        captured[index]?.resolve();
        await held[index]?.promise;
        return target;
      }) as typeof nodeFs.realpath);
      const requests: Promise<unknown>[] = [];
      try {
        const original = checkAllowed(join(former, 'photo.xmp'));
        requests.push(original);
        await captured[0].promise;
        if (mode === 'retargeted') {
          await rm(alias);
          await symlink(current, alias);
        }
        const waiters = Promise.all(
          Array.from({ length: 5 }, () => checkAllowed(join(former, 'photo.xmp'))),
        );
        requests.push(waiters);
        await nextTurn();
        expect(calls.length).toBe(1);
        held[0].resolve();
        await captured[1].promise;
        const target = mode === 'retargeted' ? current : former;
        const later = Promise.all(
          Array.from({ length: 5 }, () => checkAllowed(join(target, 'photo.xmp'))),
        );
        requests.push(later);
        await nextTurn();
        expect(calls.length).toBe(2);
        held[1].resolve();
        await captured[2].promise;
        const results = await waiters;
        expect(results?.map((result) => result.ok)).toEqual(
          Array.from({ length: 5 }, () => mode === 'stable'),
        );
        held[2].resolve();
        expect((await later).every((result) => result.ok)).toBe(true);
        expect(calls.length).toBe(3);
        await original;
      } finally {
        held.forEach((gate) => gate.resolve());
        await Promise.allSettled(requests);
        probe.mockRestore();
      }
    },
  );

  for (const nested of [false, true]) {
    test(`${kind} probes revalidate a retargeted ${nested ? 'ancestor' : 'root'} alias`, async () => {
      using live = await createLiveTestDatabase('file');
      const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-root-retarget-')));
      temporaryRoots.push(fixture);
      const former = join(fixture, 'former');
      const current = join(fixture, 'current');
      const primary = join(fixture, 'primary');
      const alias = join(fixture, 'alias');
      await Promise.all([mkdir(former), mkdir(current), mkdir(primary)]);
      const formerRoot = nested ? join(former, 'library') : former;
      const currentRoot = nested ? join(current, 'library') : current;
      if (nested) await Promise.all([mkdir(formerRoot), mkdir(currentRoot)]);
      await Promise.all(
        [formerRoot, currentRoot].map((root) => writeFile(join(root, 'photo.xmp'), '<xmpmeta/>')),
      );
      await symlink(former, alias);
      const configured = nested ? join(alias, 'library') : alias;
      insertFolder(live.db, { path: kind === 'primary' ? configured : primary });
      invalidateLibraryRoots();
      delete process.env.MAPLE_ROOTS;
      const config = kind === 'primary' ? { [configured]: [primary] } : { [primary]: [configured] };
      setMirrorRoots(config);
      const generation = mirrorGeneration();
      const captured = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const actualRealpath = nodeFs.realpath.bind(nodeFs);
      let calls = 0;
      const probe = spyOn(nodeFs, 'realpath').mockImplementation((async (
        requested: Parameters<typeof nodeFs.realpath>[0],
      ) => {
        if (requested !== configured || ++calls !== 1) return actualRealpath(requested);
        const target = await actualRealpath(requested);
        captured.resolve();
        await held.promise;
        return target;
      }) as typeof nodeFs.realpath);
      try {
        const original = checkAllowed(join(formerRoot, 'photo.xmp'));
        await captured.promise;
        await rm(alias);
        await symlink(current, alias);
        setMirrorRoots(config);
        expect(mirrorGeneration()).toBe(generation);
        const read = safeReadFile(join(formerRoot, 'photo.xmp'));
        const write = safeWriteAllowed(join(formerRoot, 'new.xmp'));
        const fresh = safeReadFile(join(currentRoot, 'photo.xmp'));
        await Bun.sleep(20);
        held.resolve();
        const results = await Promise.all([read, write, fresh, original]);
        expect(results[0].ok).toBe(false);
        expect(results[1].ok).toBe(false);
        expect(results[2].data?.toString()).toBe('<xmpmeta/>');
      } finally {
        held.resolve();
        probe.mockRestore();
      }
    });
  }
}
