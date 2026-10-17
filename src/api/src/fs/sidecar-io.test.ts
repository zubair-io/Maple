import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import * as nativeFs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as rootModule from './root.ts';
import type { OpResult } from './root.ts';
import * as mirroredFs from './mirrored.ts';
import { deleteSidecar, writeSidecarAtomic, writeSidecarCreateOnly } from './sidecar-io.ts';
import { serializeSidecarWrite } from './sidecar-write-order.ts';
import { preparePrimarySidecarWrite } from './xmp.ts';

// The sidecar jail consults MAPLE_ROOTS / the library list (#4749); this suite
// mocks the fs authorizer and has no database, so declare the temp dir as a root.
const previousRoots = process.env.MAPLE_ROOTS;
beforeAll(() => {
  process.env.MAPLE_ROOTS = os.tmpdir();
});
afterAll(() => {
  if (previousRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = previousRoots;
});

test('cancellation releases sidecar writes while filesystem authorization is still pending', async () => {
  const destinations = ['atomic.xmp', 'create-only.xmp', 'delete.xmp', 'prepare.xmp'].map((name) =>
    path.join(os.tmpdir(), `maple-sidecar-io-${process.pid}`, name),
  );
  const authorization = new Map(
    destinations.map((destination) => [destination, Promise.withResolvers<OpResult<string>>()]),
  );
  const authorize = spyOn(rootModule, 'safeWriteAllowed').mockImplementation(
    (destination) => authorization.get(destination)!.promise,
  );
  const controllers = destinations.map(() => new AbortController());

  try {
    const pending = [
      writeSidecarAtomic(destinations[0]!, 'xmp', 'Atomic write failed', controllers[0]!.signal),
      writeSidecarCreateOnly(
        destinations[1]!,
        'xmp',
        'Create-only write failed',
        controllers[1]!.signal,
      ),
      deleteSidecar(destinations[2]!, 'Delete failed', controllers[2]!.signal),
      preparePrimarySidecarWrite(destinations[3]!, '<x:xmpmeta />', controllers[3]!.signal),
    ];
    await Bun.sleep(0);
    controllers.forEach((controller) => controller.abort());

    const results = await Promise.all(pending);
    expect(results.every((result) => !result.ok && 'error' in result && result.error)).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(4);
  } finally {
    destinations.forEach((destination) =>
      authorization.get(destination)!.resolve({ ok: true, data: destination }),
    );
    authorize.mockRestore();
  }
});

test('cancelling temp staging returns promptly and removes a temp opened afterward', async () => {
  const directory = await nativeFs.mkdtemp(
    path.join(os.tmpdir(), `maple-sidecar-stage-${process.pid}-`),
  );
  const destination = path.join(directory, 'photo.xmp');
  const tmpPrefix = `${destination}.tmp.${process.pid}.`;
  const { promise: openStarted, resolve: markOpenStarted } = Promise.withResolvers<void>();
  const { promise: releaseOpen, resolve: resumeOpen } = Promise.withResolvers<void>();
  const { promise: openResolved, resolve: markOpenResolved } = Promise.withResolvers<void>();
  const { promise: lateCleanup, resolve: markLateCleanup } = Promise.withResolvers<void>();
  const controller = new AbortController();
  let temporaryPath = '';
  let cleanupAttempts = 0;

  const authorization = spyOn(rootModule, 'safeWriteAllowed').mockResolvedValue({
    ok: true,
    data: destination,
  });
  const realOpen = mirroredFs.open.bind(mirroredFs);
  const open = spyOn(mirroredFs, 'open').mockImplementation((async (
    ...args: Parameters<typeof mirroredFs.open>
  ) => {
    if (!String(args[0]).startsWith(tmpPrefix)) return realOpen(...args);
    temporaryPath = String(args[0]);
    markOpenStarted();
    await releaseOpen;
    const handle = await realOpen(...args);
    markOpenResolved();
    return handle;
  }) as never);
  const realUnlink = mirroredFs.unlink.bind(mirroredFs);
  const unlink = spyOn(mirroredFs, 'unlink').mockImplementation((async (
    ...args: Parameters<typeof mirroredFs.unlink>
  ) => {
    if (String(args[0]) === temporaryPath && temporaryPath && ++cleanupAttempts === 2) {
      markLateCleanup();
    }
    return realUnlink(...args);
  }) as never);

  try {
    const pending = writeSidecarAtomic(
      destination,
      '<x:xmpmeta />',
      'XMP write failed',
      controller.signal,
    );
    await openStarted;
    controller.abort();

    await expect(
      Promise.race([
        pending,
        Bun.sleep(100).then(() => {
          throw new Error('temp staging did not return after cancellation');
        }),
      ]),
    ).resolves.toMatchObject({ ok: false });

    resumeOpen();
    await openResolved;
    await lateCleanup;
    expect(await nativeFs.readdir(directory)).not.toContain(path.basename(temporaryPath));
    expect(await nativeFs.readdir(directory)).not.toContain('photo.xmp');
  } finally {
    resumeOpen();
    authorization.mockRestore();
    open.mockRestore();
    unlink.mockRestore();
    await nativeFs.rm(directory, { recursive: true, force: true });
  }
});

test('canceled atomic and create-only writes do not wait for stalled temp cleanup', async () => {
  for (const [name, write] of [
    ['atomic', writeSidecarAtomic],
    ['create-only', writeSidecarCreateOnly],
  ] as const) {
    const directory = await nativeFs.mkdtemp(
      path.join(os.tmpdir(), `maple-sidecar-cleanup-${name}-${process.pid}-`),
    );
    const destination = path.join(directory, 'photo.xmp');
    const tmpPrefix = `${destination}.tmp.${process.pid}.`;
    const { promise: openStarted, resolve: markOpenStarted } = Promise.withResolvers<void>();
    const { promise: releaseOpen, resolve: resumeOpen } = Promise.withResolvers<void>();
    const { promise: openResolved, resolve: markOpenResolved } = Promise.withResolvers<void>();
    const { promise: cleanupStarted, resolve: markCleanupStarted } = Promise.withResolvers<void>();
    const { promise: releaseCleanup, resolve: resumeCleanup } = Promise.withResolvers<void>();
    const { promise: lateCleanupFinished, resolve: markLateCleanupFinished } =
      Promise.withResolvers<void>();
    const controller = new AbortController();
    let temporaryPath = '';
    let cleanupAttempts = 0;

    const authorization = spyOn(rootModule, 'safeWriteAllowed').mockResolvedValue({
      ok: true,
      data: destination,
    });
    const realOpen = mirroredFs.open.bind(mirroredFs);
    const open = spyOn(mirroredFs, 'open').mockImplementation((async (
      ...args: Parameters<typeof mirroredFs.open>
    ) => {
      if (!String(args[0]).startsWith(tmpPrefix)) return realOpen(...args);
      temporaryPath = String(args[0]);
      markOpenStarted();
      await releaseOpen;
      const handle = await realOpen(...args);
      markOpenResolved();
      return handle;
    }) as never);
    const realUnlink = mirroredFs.unlink.bind(mirroredFs);
    const unlink = spyOn(mirroredFs, 'unlink').mockImplementation((async (
      ...args: Parameters<typeof mirroredFs.unlink>
    ) => {
      if (String(args[0]) !== temporaryPath || !temporaryPath) return realUnlink(...args);
      cleanupAttempts++;
      if (cleanupAttempts === 1) {
        markCleanupStarted();
        await releaseCleanup;
      }
      try {
        return await realUnlink(...args);
      } finally {
        if (cleanupAttempts === 2) markLateCleanupFinished();
      }
    }) as never);

    try {
      const pending = serializeSidecarWrite(
        destination,
        () => write(destination, '<x:xmpmeta />', `${name} write failed`, controller.signal),
        {
          admissionScope: directory,
          resolveDestination: async () => destination,
          signal: controller.signal,
        },
      );
      await openStarted;
      controller.abort();
      await cleanupStarted;

      await expect(
        Promise.race([
          pending,
          Bun.sleep(100).then(() => {
            throw new Error(`${name} write waited for stalled temp cleanup`);
          }),
        ]),
      ).resolves.toMatchObject({ ok: false });

      resumeCleanup();
      resumeOpen();
      await openResolved;
      await lateCleanupFinished;
      await expect(nativeFs.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(nativeFs.lstat(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      resumeCleanup();
      resumeOpen();
      authorization.mockRestore();
      open.mockRestore();
      unlink.mockRestore();
      await nativeFs.rm(directory, { recursive: true, force: true });
    }
  }
});

test('canceling after publication releases the barrier while the final stat is stalled', async () => {
  const directory = await nativeFs.mkdtemp(
    path.join(os.tmpdir(), `maple-sidecar-publish-stat-${process.pid}-`),
  );
  const destination = path.join(directory, 'photo.xmp');
  const controller = new AbortController();
  const authorization = spyOn(rootModule, 'safeWriteAllowed').mockResolvedValue({
    ok: true,
    data: destination,
  });
  const realStat = mirroredFs.stat.bind(mirroredFs);
  const { promise: stalledStat, resolve: releaseStalledStat } = Promise.withResolvers<void>();
  const { promise: statStarted, resolve: markStatStarted } = Promise.withResolvers<void>();
  let destinationStats = 0;
  const stat = spyOn(mirroredFs, 'stat').mockImplementation((async (
    ...args: Parameters<typeof mirroredFs.stat>
  ) => {
    if (String(args[0]) === destination && destinationStats++ === 0) {
      markStatStarted();
      await stalledStat;
    }
    return realStat(...args);
  }) as never);

  try {
    const canceled = serializeSidecarWrite(
      destination,
      () => writeSidecarAtomic(destination, 'first', 'XMP write failed', controller.signal),
      {
        admissionScope: directory,
        resolveDestination: async () => destination,
        signal: controller.signal,
      },
    );
    await statStarted;
    controller.abort();
    await expect(
      Promise.race([
        canceled,
        Bun.sleep(100).then(() => {
          throw new Error('post-publication stat did not return after cancellation');
        }),
      ]),
    ).resolves.toMatchObject({ ok: false });

    await expect(
      serializeSidecarWrite(
        destination,
        () => writeSidecarAtomic(destination, 'second', 'XMP write failed'),
        { admissionScope: directory, resolveDestination: async () => destination },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(await nativeFs.readFile(destination, 'utf8')).toBe('second');
    expect(destinationStats).toBe(2);
  } finally {
    releaseStalledStat();
    authorization.mockRestore();
    stat.mockRestore();
    await nativeFs.rm(directory, { recursive: true, force: true });
  }
});
