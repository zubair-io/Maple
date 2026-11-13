import { expect, test } from 'bun:test';
import * as fs from './mirrored';
import * as os from 'node:os';
import * as path from 'node:path';
import { serializeSidecarWrite, serializeSidecarWrites } from './sidecar-write-order';

test('a nested transaction refuses busy new names instead of deadlocking behind its own held name', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-transaction-'));
  const a = path.join(root, 'a.xmp');
  const b = path.join(root, 'b.xmp');
  const c = path.join(root, 'c.xmp');
  const entered = Promise.withResolvers<void>();
  const inspect = Promise.withResolvers<void>();
  let queued: Promise<void> | undefined;
  try {
    const owner = serializeSidecarWrites([a, b], async () => {
      entered.resolve();
      await inspect.promise;
      await serializeSidecarWrite(a, () => fs.writeFile(a, '<owned/>'));
      await expect(
        serializeSidecarWrites([a, c], () => fs.writeFile(c, '<nested/>')),
      ).rejects.toThrow('busy new name');
    });
    await entered.promise;
    queued = serializeSidecarWrites([b, c], () => fs.writeFile(c, '<queued/>'));
    // Let the union writer reserve its keys while waiting behind b.
    await Bun.sleep(20);
    inspect.resolve();
    await owner;
    await queued;
    expect(await fs.readFile(a, 'utf8')).toBe('<owned/>');
    expect(await fs.readFile(c, 'utf8')).toBe('<queued/>');
  } finally {
    inspect.resolve();
    await queued;
    await fs.rm(root, { recursive: true, force: true });
  }
});
