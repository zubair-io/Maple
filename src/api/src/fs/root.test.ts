import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// Temp-only symlink fixtures intentionally bypass durable mirrored product I/O.
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { getRegisteredRoots, registerRoot, safeWriteAllowed, unregisterRoot } from './root.ts';

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
  test('handles MAPLE_ROOTS unset before the cache is initialized', async () => {
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
    expect(JSON.parse(stdout)).toEqual({
      roots: [],
      result: { ok: true, data: join(await realpath(fixture), 'photo.xmp') },
    });
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
