import { expect, spyOn, test } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import * as rootModule from './root.ts';
import type { OpResult } from './root.ts';
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
