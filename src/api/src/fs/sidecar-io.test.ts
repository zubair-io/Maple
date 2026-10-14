import { expect, spyOn, test } from 'bun:test';
import * as nativeFs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as rootModule from './root.ts';
import type { OpResult } from './root.ts';
import * as mirroredFs from './mirrored.ts';
import { deleteSidecar, writeSidecarAtomic, writeSidecarCreateOnly } from './sidecar-io.ts';
import { preparePrimarySidecarWrite } from './xmp.ts';

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
