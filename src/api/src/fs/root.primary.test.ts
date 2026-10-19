import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
// Temp-only symlink fixtures intentionally bypass durable mirrored product I/O.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAllowed,
  registerRoot,
  safeReadFile,
  safeWriteAllowed,
  unregisterRoot,
} from './root.ts';
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
  invalidateLibraryRoots();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.each(['runtime', 'SQLite'] as const)(
  'MAPLE_ROOTS remains additive with %s roots for reads, writes, and revocation',
  async (source) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-primary-additive-')));
    temporaryRoots.push(fixture);
    const configured = join(fixture, 'configured');
    const library = join(fixture, 'library');
    const outside = join(fixture, 'outside');
    await Promise.all([mkdir(configured), mkdir(library), mkdir(outside)]);
    process.env.MAPLE_ROOTS = configured;
    const live = await createLiveTestDatabase();
    try {
      if (source === 'runtime') registerRoot(library);
      else insertFolder(live.db, { path: library, slug: 'library' });
      invalidateLibraryRoots();
      for (const root of [configured, library]) {
        await writeFile(join(root, 'photo.xmp'), '<existing/>');
        expect((await safeReadFile(join(root, 'photo.xmp'))).data?.toString()).toBe('<existing/>');
        const write = await safeWriteAllowed(join(root, 'new.xmp'));
        expect(write).toEqual({ ok: true, data: join(root, 'new.xmp') });
        await writeFile(write.data!, '<new/>');
        expect((await safeReadFile(write.data!)).data?.toString()).toBe('<new/>');
        await symlink(join(outside, 'missing.xmp'), join(root, 'escape.xmp'));
        expect((await safeWriteAllowed(join(root, 'escape.xmp'))).ok).toBe(false);
      }
      await writeFile(join(outside, 'photo.xmp'), '<outside/>');
      expect((await safeReadFile(join(outside, 'photo.xmp'))).ok).toBe(false);
      expect((await safeWriteAllowed(join(outside, 'new.xmp'))).ok).toBe(false);
      if (source === 'runtime') unregisterRoot(library);
      else live.db.query('DELETE FROM folders WHERE path = ?').run(library);
      invalidateLibraryRoots();
      expect((await safeReadFile(join(library, 'photo.xmp'))).ok).toBe(false);
      expect((await safeWriteAllowed(join(library, 'new.xmp'))).ok).toBe(false);
      expect((await safeReadFile(join(configured, 'photo.xmp'))).ok).toBe(true);
      expect((await safeWriteAllowed(join(configured, 'new.xmp'))).ok).toBe(true);
    } finally {
      unregisterRoot(library);
      live.close();
      invalidateLibraryRoots();
    }
  },
);

test.each(['directory', 'file'] as const)(
  'authorizes cross-library %s symlinks and revalidates the destination root',
  async (kind) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-primary-cross-root-')));
    temporaryRoots.push(fixture);
    const libraryA = join(fixture, 'library-a');
    const libraryB = join(fixture, 'library-b');
    const aliasB = join(fixture, 'alias-b');
    const outside = join(fixture, 'outside');
    await Promise.all([mkdir(libraryA), mkdir(libraryB), mkdir(outside)]);
    await symlink(libraryB, aliasB);
    await writeFile(join(libraryB, 'photo.xmp'), '<existing/>');
    const link = join(libraryA, kind === 'directory' ? 'linked' : 'linked.xmp');
    await symlink(kind === 'directory' ? libraryB : join(libraryB, 'photo.xmp'), link);
    const readPath = kind === 'directory' ? join(link, 'photo.xmp') : link;
    const writePath = kind === 'directory' ? join(link, 'nested', 'new.xmp') : link;
    const destination =
      kind === 'directory' ? join(libraryB, 'nested', 'new.xmp') : join(libraryB, 'photo.xmp');
    const dangling = join(libraryA, 'dangling.xmp');
    await symlink(join(libraryB, 'missing.xmp'), dangling);
    delete process.env.MAPLE_ROOTS;

    const live = await createLiveTestDatabase();
    try {
      insertFolder(live.db, { path: libraryA, slug: 'library-a' });
      insertFolder(live.db, { path: aliasB, slug: 'library-b' });
      invalidateLibraryRoots();
      expect((await safeReadFile(readPath)).data?.toString()).toBe('<existing/>');
      expect(await safeWriteAllowed(writePath)).toEqual({ ok: true, data: destination });
      if (kind === 'directory') await mkdir(join(libraryB, 'nested'));
      await writeFile(destination, '<updated/>');
      expect((await safeReadFile(writePath)).data?.toString()).toBe('<updated/>');
      expect((await safeWriteAllowed(dangling)).ok).toBe(true);
      expect((await safeWriteAllowed(join(libraryA, 'new.xmp'))).ok).toBe(true);

      await rm(aliasB);
      await symlink(outside, aliasB);
      expect((await safeReadFile(readPath)).ok).toBe(false);
      expect((await safeWriteAllowed(writePath)).ok).toBe(false);
      expect((await safeWriteAllowed(dangling)).ok).toBe(false);

      await rm(aliasB);
      await symlink(libraryB, aliasB);
      expect((await safeReadFile(readPath)).ok).toBe(true);
      live.db.query('DELETE FROM folders WHERE path = ?').run(aliasB);
      invalidateLibraryRoots();
      expect((await safeReadFile(readPath)).ok).toBe(false);
      expect((await safeWriteAllowed(writePath)).ok).toBe(false);
      expect((await safeWriteAllowed(dangling)).ok).toBe(false);
    } finally {
      live.close();
      invalidateLibraryRoots();
    }
  },
);

test('a retargeted SQLite library alias stops authorizing its former directory without DB invalidation', async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-primary-retarget-')));
  temporaryRoots.push(fixture);
  const alias = join(fixture, 'library');
  const former = join(fixture, 'former');
  const current = join(fixture, 'current');
  await Promise.all([mkdir(former), mkdir(current)]);
  await writeFile(join(former, 'photo.xmp'), '<former/>');
  await writeFile(join(current, 'photo.xmp'), '<current/>');
  await symlink(former, alias);
  const configured = join(fixture, 'configured');
  await mkdir(configured);
  process.env.MAPLE_ROOTS = configured;

  const live = await createLiveTestDatabase();
  try {
    insertFolder(live.db, { path: alias, slug: 'library' });
    invalidateLibraryRoots();
    expect((await safeReadFile(join(former, 'photo.xmp'))).data?.toString()).toBe('<former/>');
    await rm(alias);
    await symlink(current, alias);
    expect((await safeReadFile(join(former, 'photo.xmp'))).ok).toBe(false);
    expect((await safeWriteAllowed(join(former, 'new.xmp'))).ok).toBe(false);
    expect((await safeReadFile(join(alias, 'photo.xmp'))).data?.toString()).toBe('<current/>');
    const write = await safeWriteAllowed(join(alias, 'new.xmp'));
    expect(write.ok).toBe(true);
    await writeFile(write.data!, '<new/>');
    expect((await safeReadFile(join(alias, 'new.xmp'))).data?.toString()).toBe('<new/>');
    process.env.MAPLE_ROOTS = former;
    expect((await safeReadFile(join(former, 'photo.xmp'))).ok).toBe(true);
    expect((await safeReadFile(join(alias, 'new.xmp'))).ok).toBe(true);
  } finally {
    live.close();
    invalidateLibraryRoots();
  }
});

test('later SQLite-root requests revalidate after a held old alias lookup', async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-primary-held-')));
  temporaryRoots.push(fixture);
  const alias = join(fixture, 'library');
  const former = join(fixture, 'former');
  const current = join(fixture, 'current');
  await Promise.all([mkdir(former), mkdir(current)]);
  await writeFile(join(former, 'photo.xmp'), '<former/>');
  await symlink(former, alias);
  delete process.env.MAPLE_ROOTS;

  const live = await createLiveTestDatabase();
  insertFolder(live.db, { path: alias, slug: 'library' });
  invalidateLibraryRoots();
  const actualRealpath = nodeFs.realpath.bind(nodeFs);
  let aliasCalls = 0;
  let captured!: () => void;
  const secondCaptured = new Promise<void>((resolve) => (captured = resolve));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const probe = spyOn(nodeFs, 'realpath').mockImplementation((async (
    requested: Parameters<typeof nodeFs.realpath>[0],
  ) => {
    if (requested !== alias) return actualRealpath(requested);
    aliasCalls++;
    const answer = await actualRealpath(requested);
    if (aliasCalls === 2) {
      captured();
      await held;
    }
    return answer;
  }) as typeof nodeFs.realpath);
  try {
    const prior = safeReadFile(join(former, 'photo.xmp'));
    await secondCaptured;
    await rm(alias);
    await symlink(current, alias);
    const later = Array.from({ length: 8 }, () => safeReadFile(join(former, 'photo.xmp')));
    await Bun.sleep(20);
    expect(aliasCalls).toBe(2);
    release();
    expect((await Promise.all(later)).every((result) => !result.ok)).toBe(true);
    expect(aliasCalls).toBe(4);
    await prior;
  } finally {
    release();
    probe.mockRestore();
    live.close();
    invalidateLibraryRoots();
  }
}, 10_000);

test('an expired queued primary probe never starts later filesystem work', async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-primary-timeout-')));
  temporaryRoots.push(fixture);
  const alias = join(fixture, 'library');
  const primary = join(fixture, 'primary');
  await mkdir(primary);
  await symlink(primary, alias);
  delete process.env.MAPLE_ROOTS;
  const live = await createLiveTestDatabase();
  insertFolder(live.db, { path: alias, slug: 'library' });
  invalidateLibraryRoots();
  const actualRealpath = nodeFs.realpath.bind(nodeFs);
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => (started = resolve));
  const probe = spyOn(nodeFs, 'realpath').mockImplementation((async (
    requested: Parameters<typeof nodeFs.realpath>[0],
  ) => {
    if (requested !== alias) return actualRealpath(requested);
    calls++;
    started();
    await held;
    return actualRealpath(requested);
  }) as typeof nodeFs.realpath);
  try {
    const first = checkAllowed(join(primary, 'first.xmp'));
    await firstStarted;
    const later = checkAllowed(join(primary, 'later.xmp'));
    expect((await later).ok).toBe(false);
    expect(calls).toBe(1);
    release();
    await first;
    await Bun.sleep(20);
    expect(calls).toBe(2);
  } finally {
    release();
    probe.mockRestore();
    live.close();
    invalidateLibraryRoots();
  }
}, 8_000);

test('a held probe cannot cross an SQLite root removal and re-addition', async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-primary-generation-')));
  temporaryRoots.push(fixture);
  const alias = join(fixture, 'library');
  const primary = join(fixture, 'primary');
  await mkdir(primary);
  await symlink(primary, alias);
  await writeFile(join(primary, 'photo.xmp'), '<xmpmeta/>');
  delete process.env.MAPLE_ROOTS;
  const live = await createLiveTestDatabase();
  insertFolder(live.db, { path: alias, slug: 'library' });
  invalidateLibraryRoots();
  const actualRealpath = nodeFs.realpath.bind(nodeFs);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => (started = resolve));
  const probe = spyOn(nodeFs, 'realpath').mockImplementation((async (
    requested: Parameters<typeof nodeFs.realpath>[0],
  ) => {
    if (requested === alias) {
      started();
      await held;
    }
    return actualRealpath(requested);
  }) as typeof nodeFs.realpath);
  try {
    const oldRequest = safeReadFile(join(primary, 'photo.xmp'));
    await firstStarted;
    live.db.query('DELETE FROM folders WHERE path = ?').run(alias);
    invalidateLibraryRoots();
    insertFolder(live.db, { path: alias, slug: 'library' });
    invalidateLibraryRoots();
    expect((await safeReadFile(join(primary, 'photo.xmp'))).ok).toBe(false);
    release();
    expect((await oldRequest).ok).toBe(false);
    expect((await safeReadFile(join(primary, 'photo.xmp'))).ok).toBe(true);
  } finally {
    release();
    probe.mockRestore();
    live.close();
    invalidateLibraryRoots();
  }
}, 10_000);
