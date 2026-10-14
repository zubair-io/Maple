import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { serializeSidecarWrite } from './sidecar-write-order';

test('file symlink aliases stay serialized across distinct library scopes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-cross-library-alias-'));
  try {
    const firstLibrary = path.join(root, 'first-library');
    const secondLibrary = path.join(root, 'second-library');
    const destination = path.join(root, 'target.xmp');
    const firstAlias = path.join(firstLibrary, 'photo.xmp');
    const secondAlias = path.join(secondLibrary, 'alias.xmp');
    await Promise.all([
      fs.mkdir(firstLibrary),
      fs.mkdir(secondLibrary),
      fs.writeFile(destination, ''),
    ]);
    await Promise.all([fs.symlink(destination, firstAlias), fs.symlink(destination, secondAlias)]);

    const { promise: releaseFirstResolution, resolve: resolveFirstResolution } =
      Promise.withResolvers<void>();
    const { promise: secondResolutionFinished, resolve: markSecondResolutionFinished } =
      Promise.withResolvers<void>();
    const order: string[] = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const write = (label: string) => async () => {
      activeWrites++;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await Bun.sleep(5);
      order.push(label);
      activeWrites--;
      return label;
    };
    const first = serializeSidecarWrite(firstAlias, write('first'), {
      admissionScope: firstLibrary,
      resolveDestination: async () => {
        await releaseFirstResolution;
        return fs.realpath(firstAlias);
      },
    });
    const second = serializeSidecarWrite(secondAlias, write('second'), {
      admissionScope: secondLibrary,
      resolveDestination: async () => {
        const resolved = await fs.realpath(secondAlias);
        markSecondResolutionFinished();
        return resolved;
      },
    });

    await secondResolutionFinished;
    await Bun.sleep(10);
    resolveFirstResolution();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(maxActiveWrites).toBe(1);
    expect(order.toSorted()).toEqual(['first', 'second']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an aborted queued write keeps later writes behind its active predecessor', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-aborted-middle-'));
  try {
    const destination = path.join(root, 'photo.xmp');
    const { promise: firstStarted, resolve: markFirstStarted } = Promise.withResolvers<void>();
    const { promise: releaseFirst, resolve: releaseFirstWrite } = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = serializeSidecarWrite(destination, async () => {
      markFirstStarted();
      await releaseFirst;
      order.push('first');
    });
    await firstStarted;

    const controller = new AbortController();
    const second = serializeSidecarWrite(
      destination,
      async () => {
        order.push('second');
      },
      { signal: controller.signal },
    );
    await Bun.sleep(10);
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });

    let thirdStarted = false;
    const third = serializeSidecarWrite(destination, async () => {
      thirdStarted = true;
      order.push('third');
    });
    await Bun.sleep(10);
    expect(thirdStarted).toBe(false);

    releaseFirstWrite();
    await Promise.all([first, third]);
    expect(order).toEqual(['first', 'third']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an aborted admission waiter stays behind a predecessor resolving an alias', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-aborted-admission-'));
  try {
    const library = path.join(root, 'library');
    const destination = path.join(library, 'photo.xmp');
    await fs.mkdir(library);

    const realpath = fs.realpath.bind(fs);
    const { promise: parentLookupStarted, resolve: markParentLookupStarted } =
      Promise.withResolvers<void>();
    const { promise: releaseParentLookup, resolve: releaseStalledLookup } =
      Promise.withResolvers<void>();
    let stalled = false;
    const realpathSpy = spyOn(fs, 'realpath').mockImplementation((async (
      ...args: Parameters<typeof fs.realpath>
    ) => {
      if (!stalled && args[0] === library) {
        stalled = true;
        markParentLookupStarted();
        await releaseParentLookup;
      }
      return realpath(...args);
    }) as never);

    try {
      const order: string[] = [];
      const first = serializeSidecarWrite(
        destination,
        async () => {
          order.push('first');
        },
        { admissionScope: library },
      );
      await parentLookupStarted;

      const controller = new AbortController();
      const second = serializeSidecarWrite(
        destination,
        async () => {
          order.push('second');
        },
        { admissionScope: library, signal: controller.signal },
      );
      controller.abort();
      await expect(second).rejects.toMatchObject({ name: 'AbortError' });

      const third = serializeSidecarWrite(
        destination,
        async () => {
          order.push('third');
        },
        { admissionScope: library },
      );
      await Bun.sleep(10);
      expect(order).toEqual([]);

      releaseStalledLookup();
      await Promise.all([first, third]);
      expect(order).toEqual(['first', 'third']);
    } finally {
      releaseStalledLookup();
      realpathSpy.mockRestore();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('canonical destination spelling keeps an aliased path locked after parent replacement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-parent-alias-'));
  try {
    const parent = path.join(root, 'photos');
    const oldParent = path.join(root, 'photos-old');
    const aliasParent = path.join(root, 'photos-alias');
    const aliasedDestination = path.join(aliasParent, 'photo.xmp');
    const directDestination = path.join(parent, 'photo.xmp');
    await fs.mkdir(parent);
    await fs.symlink(parent, aliasParent, 'dir');

    const { promise: firstStarted, resolve: markFirstStarted } = Promise.withResolvers<void>();
    const { promise: releaseFirst, resolve: releaseFirstWrite } = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = serializeSidecarWrite(
      aliasedDestination,
      async () => {
        markFirstStarted();
        await releaseFirst;
        order.push('first');
      },
      {
        resolveDestination: async () => {
          const realParent = await fs.realpath(path.dirname(aliasedDestination));
          return path.join(realParent, path.basename(aliasedDestination));
        },
      },
    );
    await firstStarted;

    await fs.rename(parent, oldParent);
    await fs.mkdir(parent);
    let secondStarted = false;
    const second = serializeSidecarWrite(
      directDestination,
      async () => {
        secondStarted = true;
        order.push('second');
      },
      {
        resolveDestination: async () => {
          const realParent = await fs.realpath(path.dirname(directDestination));
          return path.join(realParent, path.basename(directDestination));
        },
      },
    );

    await Bun.sleep(10);
    expect(secondStarted).toBe(false);
    releaseFirstWrite();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('aborting a stalled canonical lookup lets the next save recalculate its key', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-aborted-stat-'));
  const destination = path.join(root, 'photo.xmp');
  const realStat = fs.stat.bind(fs);
  const { promise: stalledStat, resolve: releaseStalledStat } = Promise.withResolvers<void>();
  const { promise: statStarted, resolve: markStatStarted } = Promise.withResolvers<void>();
  let statCalls = 0;
  const statSpy = spyOn(fs, 'stat').mockImplementation((async (
    ...args: Parameters<typeof fs.stat>
  ) => {
    statCalls++;
    if (statCalls === 1) {
      markStatStarted();
      await stalledStat;
    }
    return realStat(...args);
  }) as never);
  const controller = new AbortController();

  try {
    const abandoned = serializeSidecarWrite(destination, async () => 'should not write', {
      signal: controller.signal,
    });
    await statStarted;
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });

    await expect(serializeSidecarWrite(destination, async () => 'saved')).resolves.toBe('saved');
    expect(statCalls).toBe(2);
  } finally {
    statSpy.mockRestore();
    releaseStalledStat();
    await Bun.sleep(0);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a stalled parent stat in one library does not block another library', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-stalled-stat-'));
  const offlineLibrary = path.join(root, 'offline');
  const healthyLibrary = path.join(root, 'healthy');
  await Promise.all([fs.mkdir(offlineLibrary), fs.mkdir(healthyLibrary)]);
  const realStat = fs.stat.bind(fs);
  const { promise: stalledStat, resolve: releaseStalledStat } = Promise.withResolvers<void>();
  const { promise: statStarted, resolve: markStatStarted } = Promise.withResolvers<void>();
  let statCalls = 0;
  const statSpy = spyOn(fs, 'stat').mockImplementation((async (
    ...args: Parameters<typeof fs.stat>
  ) => {
    statCalls++;
    if (statCalls === 1) {
      markStatStarted();
      await stalledStat;
    }
    return realStat(...args);
  }) as never);
  let first: Promise<void> | undefined;

  try {
    first = serializeSidecarWrite(path.join(offlineLibrary, 'offline.xmp'), async () => undefined, {
      admissionScope: offlineLibrary,
    });
    await statStarted;

    await expect(
      serializeSidecarWrite(path.join(healthyLibrary, 'healthy.xmp'), async () => 'healthy', {
        admissionScope: healthyLibrary,
      }),
    ).resolves.toBe('healthy');

    releaseStalledStat();
    await first;
  } finally {
    releaseStalledStat();
    statSpy.mockRestore();
    await first?.catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a resolver classifies a missing destination before parent stat failure leaks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-missing-resolver-'));
  try {
    const missingDestination = path.join(root, 'missing', 'photo.xmp');
    const denied = new Error('destination was rejected');
    await expect(
      serializeSidecarWrite(missingDestination, async () => 'unreachable', {
        admissionScope: root,
        resolveDestination: async () => {
          throw denied;
        },
      }),
    ).rejects.toBe(denied);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a stalled destination resolver in one library does not block another library', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-stalled-library-'));
  try {
    const firstLibrary = path.join(root, 'offline');
    const secondLibrary = path.join(root, 'healthy');
    await Promise.all([fs.mkdir(firstLibrary), fs.mkdir(secondLibrary)]);
    const firstDestination = path.join(firstLibrary, 'first.xmp');
    const secondDestination = path.join(secondLibrary, 'second.xmp');
    const { promise: releaseResolution, resolve: resolveResolution } =
      Promise.withResolvers<void>();
    const { promise: firstResolutionStarted, resolve: markResolutionStarted } =
      Promise.withResolvers<void>();
    const order: string[] = [];
    const first = serializeSidecarWrite(
      firstDestination,
      async () => {
        order.push('offline');
      },
      {
        admissionScope: firstLibrary,
        resolveDestination: async () => {
          markResolutionStarted();
          await releaseResolution;
          return firstDestination;
        },
      },
    );
    await firstResolutionStarted;

    await expect(
      serializeSidecarWrite(
        secondDestination,
        async () => {
          order.push('healthy');
        },
        { admissionScope: secondLibrary },
      ),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['healthy']);

    resolveResolution();
    await first;
    expect(order).toEqual(['healthy', 'offline']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
