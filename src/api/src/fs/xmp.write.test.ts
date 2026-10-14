import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as nativeFs from 'node:fs/promises';
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBodyETag } from '../runtime/http-etag';
import * as mirroredFs from './mirrored.ts';
import { serializeSidecarWrite } from './sidecar-write-order';
import { writeXmpIfUnchanged } from './xmp-conditional.ts';
import {
  deleteXmpSidecar,
  updateXmpAtomic,
  writeXmpAtomic,
  writeXmpWithPrecondition,
} from './xmp.ts';

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
