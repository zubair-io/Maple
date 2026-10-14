import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { serializeSidecarWrite } from './sidecar-write-order';

describe('serializeSidecarWrite', () => {
  test('aliased paths for one file share a single chain', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-'));
    try {
      const realDir = path.join(root, 'real');
      await fs.mkdir(realDir);
      const linkDir = path.join(root, 'link');
      await fs.symlink(realDir, linkDir, 'dir');
      let active = 0;
      let maxActive = 0;
      const order: string[] = [];
      const job = (label: string) => async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(label);
        active--;
        return label;
      };
      const results = await Promise.all([
        serializeSidecarWrite(path.join(realDir, 'a.xmp'), job('real-1')),
        serializeSidecarWrite(path.join(linkDir, 'a.xmp'), job('link-1')),
        serializeSidecarWrite(path.join(realDir, 'a.xmp'), job('real-2')),
      ]);
      expect(results).toEqual(['real-1', 'link-1', 'real-2']);
      expect(maxActive).toBe(1);
      expect(order).toEqual(['real-1', 'link-1', 'real-2']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('case-only sidecar aliases share a chain on every host', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-case-'));
    try {
      let active = 0;
      let maxActive = 0;
      const job = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
      };
      await Promise.all([
        serializeSidecarWrite(path.join(root, 'photo.xmp'), job),
        serializeSidecarWrite(path.join(root, 'PHOTO.xmp'), job),
      ]);
      expect(maxActive).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('canonically equivalent Unicode sidecar names share a chain', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-unicode-'));
    try {
      let active = 0;
      let maxActive = 0;
      const job = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
      };
      await Promise.all([
        serializeSidecarWrite(path.join(root, 'caf\u00e9.xmp'), job),
        serializeSidecarWrite(path.join(root, 'cafe\u0301.xmp'), job),
      ]);
      expect(maxActive).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('same destination preserves strict FIFO order', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-fifo-'));
    try {
      const destination = path.join(root, 'a.xmp');
      const order: string[] = [];
      const job = (label: string) => async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(label);
        return label;
      };
      const results = await Promise.all([
        serializeSidecarWrite(destination, job('first')),
        serializeSidecarWrite(destination, job('second')),
        serializeSidecarWrite(destination, job('third')),
      ]);
      expect(results).toEqual(['first', 'second', 'third']);
      expect(order).toEqual(['first', 'second', 'third']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('does not admit a destination while its parent identity is unavailable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-stat-failure-'));
    try {
      const parent = path.join(root, 'offline');
      const destination = path.join(parent, 'photo.xmp');
      let writes = 0;

      await expect(
        serializeSidecarWrite(
          destination,
          async () => {
            writes++;
            return 'written';
          },
          { admissionScope: root },
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(writes).toBe(0);

      await fs.mkdir(parent);
      await expect(
        serializeSidecarWrite(
          destination,
          async () => {
            writes++;
            return 'written';
          },
          { admissionScope: root },
        ),
      ).resolves.toBe('written');
      expect(writes).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('keeps the lexical destination locked while its parent is replaced', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-parent-replaced-'));
    try {
      const parent = path.join(root, 'photos');
      const movedParent = path.join(root, 'photos-old');
      const destination = path.join(parent, 'photo.xmp');
      await fs.mkdir(parent);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const order: string[] = [];
      const first = serializeSidecarWrite(
        destination,
        async () => {
          started.resolve();
          await release.promise;
          order.push('first');
        },
        { admissionScope: root },
      );
      await started.promise;

      await fs.rename(parent, movedParent);
      await fs.mkdir(parent);
      let secondStarted = false;
      const second = serializeSidecarWrite(
        destination,
        async () => {
          secondStarted = true;
          order.push('second');
        },
        { admissionScope: root },
      );

      await Bun.sleep(10);
      expect(secondStarted).toBe(false);
      release.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual(['first', 'second']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('aborted destination resolution releases its library admission turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-aborted-resolution-'));
    try {
      const destination = path.join(root, 'photo.xmp');
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const abandoned = serializeSidecarWrite(destination, async () => 'abandoned', {
        admissionScope: root,
        signal: controller.signal,
        resolveDestination: async () => {
          started.resolve();
          return new Promise<string>(() => undefined);
        },
      });

      await started.promise;
      controller.abort();
      await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
      await expect(
        serializeSidecarWrite(destination, async () => 'next', { admissionScope: root }),
      ).resolves.toBe('next');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('different file symlink names preserve FIFO after resolving to one sidecar', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-file-alias-'));
    try {
      const destination = path.join(root, 'target.xmp');
      const firstAlias = path.join(root, 'photo.xmp');
      const secondAlias = path.join(root, 'alias.xmp');
      await fs.writeFile(destination, '');
      await Promise.all([
        fs.symlink(destination, firstAlias, 'file'),
        fs.symlink(destination, secondAlias, 'file'),
      ]);

      const order: string[] = [];
      const write = (label: string) => async () => {
        order.push(label);
        return label;
      };
      const resolveDestination = (alias: string, delayMs: number) => async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return fs.realpath(alias);
      };

      const results = await Promise.all([
        serializeSidecarWrite(firstAlias, write('first'), {
          admissionScope: root,
          resolveDestination: resolveDestination(firstAlias, 20),
        }),
        serializeSidecarWrite(secondAlias, write('second'), {
          admissionScope: root,
          resolveDestination: resolveDestination(secondAlias, 0),
        }),
      ]);
      expect(results).toEqual(['first', 'second']);
      expect(order).toEqual(['first', 'second']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('nested sidecar writers share FIFO when scoped to their library root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-nested-library-'));
    try {
      const destination = path.join(root, 'year', 'month', 'photo.xmp');
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const { promise: releaseResolution, resolve: resolveResolution } =
        Promise.withResolvers<void>();
      const order: string[] = [];
      const first = serializeSidecarWrite(
        destination,
        async () => {
          order.push('full-sidecar');
        },
        {
          admissionScope: root,
          resolveDestination: async () => {
            await releaseResolution;
            return destination;
          },
        },
      );
      const second = serializeSidecarWrite(
        destination,
        async () => {
          order.push('batch-merge');
        },
        { admissionScope: root, resolveDestination: async () => destination },
      );

      await Bun.sleep(10);
      expect(order).toEqual([]);
      resolveResolution();
      await Promise.all([first, second]);
      expect(order).toEqual(['full-sidecar', 'batch-merge']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('a rejected destination stays handled while waiting for its FIFO turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-rejected-destination-'));
    try {
      const destination = path.join(root, 'a', 'b', 'photo.xmp');
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const { promise: releaseResolution, resolve: resolveResolution } =
        Promise.withResolvers<void>();
      const first = serializeSidecarWrite(destination, async () => 'first', {
        admissionScope: root,
        resolveDestination: async () => {
          await releaseResolution;
          return destination;
        },
      });
      const observedUnhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        if (reason instanceof Error && reason.message === 'destination denied')
          observedUnhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const second = serializeSidecarWrite(destination, async () => 'second', {
          admissionScope: root,
          resolveDestination: async () => {
            throw new Error('destination denied');
          },
        });
        const secondError = second.then(
          () => null,
          (error: unknown) => error,
        );

        await Bun.sleep(30);
        resolveResolution();
        await expect(first).resolves.toBe('first');
        const error = await secondError;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('destination denied');
        await Bun.sleep(20);
        expect(observedUnhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('different destinations can write concurrently', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-parallel-'));
    try {
      let started = 0;
      let releaseWrites!: () => void;
      const bothStarted = new Promise<void>((resolve) => {
        releaseWrites = resolve;
      });
      const write = async () => {
        started++;
        if (started === 2) releaseWrites();
        await bothStarted;
      };

      await Promise.all([
        serializeSidecarWrite(path.join(root, 'a.xmp'), write),
        serializeSidecarWrite(path.join(root, 'b.xmp'), write),
      ]);
      expect(started).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('same filename in different libraries can write concurrently', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-libraries-'));
    try {
      const firstLibrary = path.join(root, 'first');
      const secondLibrary = path.join(root, 'second');
      await Promise.all([fs.mkdir(firstLibrary), fs.mkdir(secondLibrary)]);
      let started = 0;
      let releaseWrites!: () => void;
      const bothStarted = new Promise<void>((resolve) => {
        releaseWrites = resolve;
      });
      const write = async () => {
        started++;
        if (started === 2) releaseWrites();
        await bothStarted;
      };

      await Promise.all([
        serializeSidecarWrite(path.join(firstLibrary, 'IMG_0001.xmp'), write),
        serializeSidecarWrite(path.join(secondLibrary, 'IMG_0001.xmp'), write),
      ]);
      expect(started).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
