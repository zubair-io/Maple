import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as nativeFs from 'node:fs/promises';
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBodyETag } from '../runtime/http-etag';
import * as mirroredFs from './mirrored.ts';
import * as mirrorRead from './mirror-read.ts';
import { conflictCopyPath } from './xmp-conflict.ts';
import { serializeSidecarWrite } from './sidecar-write-order';
import { writeXmpIfUnchanged } from './xmp-conditional.ts';
import {
  deleteXmpSidecar,
  readXmp,
  updateXmpAtomic,
  writeXmpAtomic,
  writeXmpWithPrecondition,
} from './xmp.ts';
import { readConflictSidecar } from './xmp-conflict.ts';
import { readSidecarNoFollow } from './sidecar-io.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';

let oldRoots: string | undefined;
let root: string;

beforeEach(async () => {
  oldRoots = process.env.MAPLE_ROOTS;
  root = await realpath(await mkdtemp(join(tmpdir(), 'maple-xmp-write-')));
  process.env.MAPLE_ROOTS = root;
});

afterEach(async () => {
  if (oldRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = oldRoots;
  await rm(root, { recursive: true, force: true });
});

async function holdSidecarWrite(sidecar: string) {
  const { promise: entered, resolve: signalEntered } = Promise.withResolvers<void>();
  const { promise: released, resolve: releaseWrite } = Promise.withResolvers<void>();
  const inFlight = serializeSidecarWrite(
    sidecar,
    async () => {
      signalEntered();
      await released;
      return 'held';
    },
    { admissionScope: root, resolveDestination: async () => sidecar },
  );
  await entered;
  return { inFlight, releaseWrite };
}

// #4749 — a sidecar path that is a symlink to the original (or to anything
// that is not an .xmp file inside the jail) must never be written through,
// deleted through, or read through.
const RAW_BYTES = Buffer.from([0x49, 0x49, 0x2a, 0x00]);

async function plantSidecarSymlinkToOriginal() {
  const rawPath = join(root, 'linked.dng');
  const sidecarPath = join(root, 'linked.xmp');
  await writeFile(rawPath, RAW_BYTES);
  await symlink(rawPath, sidecarPath);
  return { rawPath, sidecarPath };
}

test('save refuses a sidecar symlinked to the original and leaves the RAW intact', async () => {
  const { rawPath, sidecarPath } = await plantSidecarSymlinkToOriginal();

  const plain = await writeXmpAtomic(rawPath, '<x:xmpmeta />', undefined, root);
  expect(plain.ok).toBe(false);
  const preconditioned = await writeXmpWithPrecondition(
    rawPath,
    '<x:xmpmeta />',
    null,
    'test-device',
    false,
    root,
  );
  expect(preconditioned.kind).toBe('error');
  const merged = await updateXmpAtomic(rawPath, () => '<x:xmpmeta />', undefined, root);
  expect(merged.ok).toBe(false);

  expect(await readFile(rawPath)).toEqual(RAW_BYTES);
  expect((await lstat(sidecarPath)).isSymbolicLink()).toBe(true);
});

test('reset refuses to delete through a sidecar symlinked to the original', async () => {
  const { rawPath, sidecarPath } = await plantSidecarSymlinkToOriginal();

  const result = await deleteXmpSidecar(rawPath, root);
  expect(result.ok).toBe(false);
  expect(await readFile(rawPath)).toEqual(RAW_BYTES);
  expect((await lstat(sidecarPath)).isSymbolicLink()).toBe(true);
});

test('read refuses a sidecar symlinked to the original', async () => {
  const { rawPath } = await plantSidecarSymlinkToOriginal();
  expect((await readXmp(rawPath)).ok).toBe(false);
});

// #4749 — the documented default deployment sets no MAPLE_ROOTS and never calls
// registerRoot for database libraries, so the sidecar jail must consult the
// library roots itself instead of inheriting the fs jail's allow-all fallback.
test('with no MAPLE_ROOTS, a sidecar symlinked outside the library roots is refused', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'maple-xmp-outside-'));
  delete process.env.MAPLE_ROOTS;
  setLibraryRootsForTests(new Map([['lib', root]]));
  try {
    const secret = join(outside, 'secret.xmp');
    await writeFile(secret, '<x:xmpmeta><secret /></x:xmpmeta>');
    const rawPath = join(root, 'db-jail.dng');
    await writeFile(rawPath, RAW_BYTES);
    await symlink(secret, join(root, 'db-jail.xmp'));

    expect((await readXmp(rawPath)).ok).toBe(false);
    expect((await writeXmpAtomic(rawPath, '<x:xmpmeta />', undefined, root)).ok).toBe(false);
    expect(await readFile(secret, 'utf8')).toBe('<x:xmpmeta><secret /></x:xmpmeta>');

    const inRoot = join(root, 'db-jail-ok.dng');
    await writeFile(inRoot, RAW_BYTES);
    expect((await writeXmpAtomic(inRoot, '<x:xmpmeta />', undefined, root)).ok).toBe(true);
  } finally {
    setLibraryRootsForTests(null);
    process.env.MAPLE_ROOTS = root;
    await rm(outside, { recursive: true, force: true });
  }
});

test('read refuses a sidecar symlinked outside the registered roots', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'maple-xmp-outside-'));
  try {
    const secret = join(outside, 'secret.xmp');
    await writeFile(secret, '<x:xmpmeta><secret /></x:xmpmeta>');
    const rawPath = join(root, 'escape.dng');
    await writeFile(rawPath, RAW_BYTES);
    await symlink(secret, join(root, 'escape.xmp'));
    await symlink(secret, join(root, 'escape (conflict from Mac).xmp'));

    expect((await readXmp(rawPath)).ok).toBe(false);
    const conflict = await readConflictSidecar(rawPath, 'escape (conflict from Mac)');
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toContain('outside all registered roots');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test('the sidecar reader refuses to follow a symlink in the final component', async () => {
  const real = join(root, 'nofollow-real.xmp');
  await writeFile(real, '<x:xmpmeta />');
  await symlink(real, join(root, 'nofollow-link.xmp'));

  expect(await readSidecarNoFollow(real)).toBe('<x:xmpmeta />');
  await expect(readSidecarNoFollow(join(root, 'nofollow-link.xmp'))).rejects.toMatchObject({
    code: 'ELOOP',
  });
});

test('a sidecar symlinked to another in-root .xmp still saves through every write path', async () => {
  const rawPath = join(root, 'alias-save.dng');
  const realSidecar = join(root, 'alias-save-real.xmp');
  await writeFile(rawPath, RAW_BYTES);
  await writeFile(realSidecar, '<x:xmpmeta />');
  await symlink(realSidecar, join(root, 'alias-save.xmp'));

  expect((await writeXmpAtomic(rawPath, '<x:xmpmeta><a /></x:xmpmeta>', undefined, root)).ok).toBe(
    true,
  );
  expect(await readFile(realSidecar, 'utf8')).toContain('<a />');
  const preconditioned = await writeXmpWithPrecondition(
    rawPath,
    '<x:xmpmeta><b /></x:xmpmeta>',
    null,
    'test-device',
    false,
    root,
  );
  expect(preconditioned.kind).toBe('ok');
  expect(await readFile(realSidecar, 'utf8')).toContain('<b />');
  const merged = await updateXmpAtomic(
    rawPath,
    () => '<x:xmpmeta><c /></x:xmpmeta>',
    undefined,
    root,
  );
  expect(merged).toEqual({ ok: true, data: 'written' });
  expect(await readFile(realSidecar, 'utf8')).toContain('<c />');
  expect((await lstat(join(root, 'alias-save.xmp'))).isSymbolicLink()).toBe(true);
});

test('read opens the path that passed authorization, not the symlink it was asked for', async () => {
  const rawPath = join(root, 'aliased.dng');
  const realSidecar = join(root, 'aliased-real.xmp');
  await writeFile(rawPath, RAW_BYTES);
  await writeFile(realSidecar, '<x:xmpmeta />');
  await symlink(realSidecar, join(root, 'aliased.xmp'));
  const readSpy = spyOn(mirrorRead, 'readFileWithFailover');
  try {
    expect((await readXmp(rawPath)).ok).toBe(true);
    expect(readSpy.mock.calls.map(([target]) => target)).toEqual([realSidecar]);
  } finally {
    readSpy.mockRestore();
  }
});

test('idempotent delete removes a dangling sidecar symlink without touching the original', async () => {
  const rawPath = join(root, 'dangling.dng');
  const sidecarPath = join(root, 'dangling.xmp');
  await writeFile(rawPath, Buffer.from([7, 3, 1]));
  await symlink(join(root, 'missing-target.xmp'), sidecarPath);

  expect(await deleteXmpSidecar(rawPath, root)).toEqual({ ok: true, existed: true });
  await expect(lstat(sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(rawPath)).toEqual(Buffer.from([7, 3, 1]));
});

test('precondition writes stop after request cancellation without changing the sidecar', async () => {
  const rawPath = join(root, 'photo.dng');
  const original = '<x:xmpmeta />';
  await writeFile(rawPath, Buffer.from([1, 2, 3]));
  await writeFile(join(root, 'photo.xmp'), original);
  const controller = new AbortController();
  controller.abort();

  const result = await writeXmpWithPrecondition(
    rawPath,
    '<x:xmpmeta><updated /></x:xmpmeta>',
    null,
    'test-device',
    false,
    root,
    controller.signal,
  );

  expect(result.kind).toBe('error');
  expect(await readFile(join(root, 'photo.xmp'), 'utf8')).toBe(original);
});

test('plain path-keyed writes stop when cancelled while queued', async () => {
  const rawPath = join(root, 'queued.dng');
  const sidecar = join(root, 'queued.xmp');
  const original = '<x:xmpmeta />';
  await writeFile(rawPath, Buffer.from([1, 2, 3]));
  await writeFile(sidecar, original);
  const held = await holdSidecarWrite(sidecar);
  const controller = new AbortController();
  const write = writeXmpAtomic(
    rawPath,
    '<x:xmpmeta><updated /></x:xmpmeta>',
    controller.signal,
    root,
  );
  controller.abort();
  held.releaseWrite();
  await held.inFlight;

  expect((await write).ok).toBe(false);
  expect(await readFile(sidecar, 'utf8')).toBe(original);
});

test('read-merge-write saves stop when cancelled while queued', async () => {
  const rawPath = join(root, 'queued-update.dng');
  const sidecar = join(root, 'queued-update.xmp');
  const original = '<x:xmpmeta>before</x:xmpmeta>';
  await writeFile(rawPath, Buffer.from([1, 2, 3]));
  await writeFile(sidecar, original);
  const held = await holdSidecarWrite(sidecar);
  const controller = new AbortController();
  const update = updateXmpAtomic(
    rawPath,
    (existing) => existing.replace('before', 'after'),
    controller.signal,
    root,
  );
  controller.abort();
  held.releaseWrite();
  await held.inFlight;

  expect((await update).ok).toBe(false);
  expect(await readFile(sidecar, 'utf8')).toBe(original);
});

test('conditional writes stop when cancelled while queued', async () => {
  const rawPath = join(root, 'queued-conditional.dng');
  const sidecar = join(root, 'queued-conditional.xmp');
  const original = '<x:xmpmeta />';
  await writeFile(rawPath, Buffer.from([1, 2, 3]));
  await writeFile(sidecar, original);
  const held = await holdSidecarWrite(sidecar);
  const controller = new AbortController();
  const write = writeXmpIfUnchanged(
    rawPath,
    '<x:xmpmeta><updated /></x:xmpmeta>',
    computeBodyETag(original),
    controller.signal,
    root,
  );
  controller.abort();
  held.releaseWrite();
  await held.inFlight;

  expect((await write).kind).toBe('error');
  expect(await readFile(sidecar, 'utf8')).toBe(original);
});

test('cancelling a stalled conditional precondition read releases the write barrier', async () => {
  const rawPath = join(root, 'stalled-conditional-read.dng');
  const sidecar = join(root, 'stalled-conditional-read.xmp');
  const original = '<x:xmpmeta />';
  await writeFile(rawPath, Buffer.from([1, 2, 3]));
  await writeFile(sidecar, original);

  const realRead = nativeFs.readFile.bind(nativeFs);
  const { promise: stalledRead, resolve: releaseStalledRead } = Promise.withResolvers<void>();
  const { promise: readStarted, resolve: markReadStarted } = Promise.withResolvers<void>();
  let sidecarReads = 0;
  const readSpy = spyOn(nativeFs, 'readFile').mockImplementation((async (
    ...args: Parameters<typeof nativeFs.readFile>
  ) => {
    if (String(args[0]) === sidecar && sidecarReads++ === 0) {
      markReadStarted();
      await stalledRead;
    }
    return realRead(...args);
  }) as never);
  const controller = new AbortController();

  try {
    const cancelled = writeXmpIfUnchanged(
      rawPath,
      '<x:xmpmeta><updated /></x:xmpmeta>',
      computeBodyETag(original),
      controller.signal,
      root,
    );
    await readStarted;
    controller.abort();
    await expect(
      Promise.race([
        cancelled,
        Bun.sleep(100).then(() => {
          throw new Error('conditional write did not return after cancellation');
        }),
      ]),
    ).resolves.toMatchObject({ kind: 'error' });

    await expect(
      writeXmpIfUnchanged(
        rawPath,
        '<x:xmpmeta><next-save /></x:xmpmeta>',
        computeBodyETag(original),
        undefined,
        root,
      ),
    ).resolves.toMatchObject({ kind: 'ok' });
    expect(sidecarReads).toBeGreaterThan(1);
  } finally {
    readSpy.mockRestore();
    releaseStalledRead();
  }
});

test('cancelling a stalled mtime precondition stat releases the write barrier', async () => {
  const rawPath = join(root, 'stalled-mtime-stat.dng');
  const sidecar = join(root, 'stalled-mtime-stat.xmp');
  const original = '<x:xmpmeta />';
  await writeFile(rawPath, Buffer.from([1, 2, 3]));
  await writeFile(sidecar, original);

  const realStat = mirroredFs.stat.bind(mirroredFs);
  const expectedEpoch = Math.floor((await realStat(sidecar)).mtimeMs / 1000);
  const { promise: stalledStat, resolve: releaseStalledStat } = Promise.withResolvers<void>();
  const { promise: statStarted, resolve: markStatStarted } = Promise.withResolvers<void>();
  let sidecarStats = 0;
  const statSpy = spyOn(mirroredFs, 'stat').mockImplementation((async (
    ...args: Parameters<typeof mirroredFs.stat>
  ) => {
    if (String(args[0]) === sidecar && sidecarStats++ === 0) {
      markStatStarted();
      await stalledStat;
    }
    return realStat(...args);
  }) as never);
  const controller = new AbortController();

  try {
    const cancelled = writeXmpWithPrecondition(
      rawPath,
      '<x:xmpmeta><updated /></x:xmpmeta>',
      expectedEpoch,
      'test-device',
      false,
      root,
      controller.signal,
    );
    await statStarted;
    controller.abort();
    await expect(
      Promise.race([
        cancelled,
        Bun.sleep(100).then(() => {
          throw new Error('mtime precondition did not return after cancellation');
        }),
      ]),
    ).resolves.toMatchObject({ kind: 'error' });

    await expect(
      writeXmpWithPrecondition(
        rawPath,
        '<x:xmpmeta><next-save /></x:xmpmeta>',
        expectedEpoch,
        'test-device',
        false,
        root,
      ),
    ).resolves.toMatchObject({ kind: 'ok' });
    expect(sidecarStats).toBeGreaterThan(1);
  } finally {
    statSpy.mockRestore();
    releaseStalledStat();
  }
});

test('cancelling a conflict-path probe releases the write barrier', async () => {
  const rawPath = join(root, 'stalled-conflict-probe.dng');
  const sidecar = join(root, 'stalled-conflict-probe.xmp');
  const conflictPath = conflictCopyPath(rawPath, 'test-device');
  const original = '<x:xmpmeta />';
  await writeFile(rawPath, Buffer.from([1, 2, 3]));
  await writeFile(sidecar, original);

  const realStat = mirroredFs.stat.bind(mirroredFs);
  const { promise: stalledStat, resolve: releaseStalledStat } = Promise.withResolvers<void>();
  const { promise: statStarted, resolve: markStatStarted } = Promise.withResolvers<void>();
  let conflictStats = 0;
  const statSpy = spyOn(mirroredFs, 'stat').mockImplementation((async (
    ...args: Parameters<typeof mirroredFs.stat>
  ) => {
    if (String(args[0]) === conflictPath && conflictStats++ === 0) {
      markStatStarted();
      await stalledStat;
    }
    return realStat(...args);
  }) as never);
  const controller = new AbortController();

  try {
    const cancelled = writeXmpWithPrecondition(
      rawPath,
      '<x:xmpmeta><conflict /></x:xmpmeta>',
      Number.MAX_SAFE_INTEGER,
      'test-device',
      false,
      root,
      controller.signal,
    );
    await statStarted;
    controller.abort();
    await expect(
      Promise.race([
        cancelled,
        Bun.sleep(100).then(() => {
          throw new Error('conflict path probe did not return after cancellation');
        }),
      ]),
    ).resolves.toMatchObject({ kind: 'error' });

    await expect(
      writeXmpWithPrecondition(
        rawPath,
        '<x:xmpmeta><next-save /></x:xmpmeta>',
        null,
        'test-device',
        false,
        root,
      ),
    ).resolves.toMatchObject({ kind: 'ok' });
    expect(await readFile(sidecar, 'utf8')).toContain('next-save');
    await expect(lstat(conflictPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    statSpy.mockRestore();
    releaseStalledStat();
  }
});

test('deletes stop when cancelled while queued', async () => {
  const rawPath = join(root, 'queued-delete.dng');
  const sidecar = join(root, 'queued-delete.xmp');
  const original = '<x:xmpmeta />';
  await writeFile(rawPath, Buffer.from([1, 2, 3]));
  await writeFile(sidecar, original);
  const held = await holdSidecarWrite(sidecar);
  const controller = new AbortController();
  const deletion = deleteXmpSidecar(rawPath, root, controller.signal);
  await Bun.sleep(10);
  controller.abort();
  held.releaseWrite();
  await held.inFlight;

  expect(await deletion).toMatchObject({ ok: false });
  expect(await readFile(sidecar, 'utf8')).toBe(original);
});
