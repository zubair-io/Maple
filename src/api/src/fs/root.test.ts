import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// Temp-only symlink fixtures intentionally bypass durable mirrored product I/O.
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, parse, sep } from 'node:path';
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

  test('keeps one destination while atomic saves replace the sidecar (#4051)', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'maple-root-replaced-')));
    temporaryRoots.push(fixture);
    const sidecar = join(fixture, 'photo.xmp');
    await writeFile(sidecar, '<xmpmeta/>');
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
