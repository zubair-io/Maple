import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { serializeSidecarWrite } from './sidecar-write-order';

test('aborting a resolved-destination lookup evicts its actual-path key', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-aborted-actual-key-'));
  const requestedParent = path.join(root, 'requested');
  const actualParent = path.join(root, 'actual');
  await Promise.all([fs.mkdir(requestedParent), fs.mkdir(actualParent)]);
  const canonicalActualParent = await fs.realpath(actualParent);
  const requestedDestination = path.join(requestedParent, 'photo.xmp');
  const actualDestination = path.join(actualParent, 'photo.xmp');
  const realStat = fs.stat.bind(fs);
  const { promise: stalledStat, resolve: releaseStalledStat } = Promise.withResolvers<void>();
  const { promise: statStarted, resolve: markStatStarted } = Promise.withResolvers<void>();
  let actualParentStats = 0;
  const statSpy = spyOn(fs, 'stat').mockImplementation((async (
    ...args: Parameters<typeof fs.stat>
  ) => {
    if (String(args[0]) === canonicalActualParent && actualParentStats++ === 0) {
      markStatStarted();
      await stalledStat;
    }
    return realStat(...args);
  }) as never);
  const controller = new AbortController();

  try {
    const abandoned = serializeSidecarWrite(requestedDestination, async () => 'unreachable', {
      admissionScope: root,
      signal: controller.signal,
      resolveDestination: async () => actualDestination,
    });
    await Promise.race([
      statStarted,
      Bun.sleep(500).then(() => {
        throw new Error('actual-destination canonical lookup did not start');
      }),
    ]);
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });

    await expect(
      Promise.race([
        serializeSidecarWrite(actualDestination, async () => 'saved', {
          admissionScope: root,
          resolveDestination: async () => actualDestination,
        }),
        Bun.sleep(100).then(() => {
          throw new Error('next write reused the abandoned actual-path lookup');
        }),
      ]),
    ).resolves.toBe('saved');
    expect(actualParentStats).toBe(2);
  } finally {
    releaseStalledStat();
    statSpy.mockRestore();
    await Bun.sleep(0);
    await fs.rm(root, { recursive: true, force: true });
  }
});
