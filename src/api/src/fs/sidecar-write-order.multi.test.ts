import { expect, test } from 'bun:test';
import * as fs from './mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { serializeSidecarWrite, serializeSidecarWrites } from './sidecar-write-order';

async function settledWithin<T>(pending: Promise<T>[]): Promise<PromiseSettledResult<T>[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('sidecar barriers deadlocked')), 2000);
  });
  try {
    return await Promise.race([Promise.allSettled(pending), deadlock]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves once every reservation admitted before this call has registered:
 * the unscoped admission lane lets a probe through only after them. */
function admittedSoFar(probe: string): Promise<void> {
  return serializeSidecarWrite(probe, async () => undefined);
}

test('a save whose name becomes an alias after it reserved does not deadlock a two-name barrier', async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-multi-')),
  );
  try {
    const alias = path.join(root, 'x.xmp');
    const target = path.join(root, 'y.xmp');
    await fs.writeFile(target, '');
    const { promise: aliasCreated, resolve: releaseResolution } = Promise.withResolvers<void>();

    const save = serializeSidecarWrite(alias, async () => 'save', {
      resolveDestination: async () => {
        await aliasCreated;
        return fs.realpath(alias);
      },
    });
    await admittedSoFar(path.join(root, 'probe-1.xmp'));
    await fs.symlink(target, alias);
    const pair = serializeSidecarWrites([alias, target], async () => 'pair');
    await admittedSoFar(path.join(root, 'probe-2.xmp'));
    releaseResolution();

    const outcomes = await settledWithin<string>([save, pair]);
    expect(outcomes).toEqual([
      { status: 'fulfilled', value: 'save' },
      { status: 'fulfilled', value: 'pair' },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
