/**
 * A Replace that rolls back after overwriting the destination restores the
 * photo it displaced (#5072), and one that commits leaves no hidden copy
 * behind. Real files in a temp dir.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { relocateFile } from './relocate.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-replace-rollback-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const abs = (rel: string) => path.join(root, ...rel.split('/'));
const read = (rel: string) => fs.readFile(abs(rel), 'utf8').catch(() => null);
async function write(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.writeFile(abs(rel), content);
}

const replace = (
  hooks: Pick<Parameters<typeof relocateFile>[0], 'onVerified' | 'beforeSourceDelete'>,
) =>
  relocateFile({
    sourceAbsPath: abs('src/IMG.HEIC'),
    destAbsPath: abs('dst/IMG.HEIC'),
    mode: 'move',
    collision: 'replace',
    ...hooks,
  });

describe('Replace rollback (#5072)', () => {
  test('a repoint that fails restores the displaced photo', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('dst/IMG.HEIC', 'old');

    const outcome = await replace({
      onVerified: async () => {
        throw new Error('repoint failed');
      },
    });

    expect(outcome.kind).toBe('error');
    expect(await read('dst/IMG.HEIC')).toBe('old');
    expect(await read('src/IMG.HEIC')).toBe('new');
    expect((await fs.readdir(abs('dst'))).sort()).toEqual(['IMG.HEIC']);
  });

  test('a lease lost before the repoint restores the displaced photo', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('dst/IMG.HEIC', 'old');

    const outcome = await replace({
      beforeSourceDelete: async () => {
        throw new Error('lease expired');
      },
    });

    expect(outcome.kind).toBe('error');
    expect(await read('dst/IMG.HEIC')).toBe('old');
    expect(await read('src/IMG.HEIC')).toBe('new');
  });

  test('a Replace that commits leaves no hidden copy of the displaced photo', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('dst/IMG.HEIC', 'old');

    const outcome = await replace({});

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC')).toBe('new');
    expect((await fs.readdir(abs('dst'))).sort()).toEqual(['IMG.HEIC']);
  });

  test('a rollback gives the displaced photo back its own edit', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.xmp', 'new edit');
    await write('dst/IMG.HEIC', 'old');
    await write('dst/IMG.xmp', 'old edit');

    await replace({
      onVerified: async () => {
        throw new Error('repoint failed');
      },
    });

    expect(await read('dst/IMG.HEIC')).toBe('old');
    expect(await read('dst/IMG.xmp')).toBe('old edit');
    expect(await read('src/IMG.xmp')).toBe('new edit');
    expect((await fs.readdir(abs('dst'))).sort()).toEqual(['IMG.HEIC', 'IMG.xmp']);
  });

  test('a rollback restores the edit a Replace without one would have cleared', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('dst/IMG.HEIC', 'old');
    await write('dst/IMG.xmp', 'old edit');

    await replace({
      beforeSourceDelete: async () => {
        throw new Error('lease expired');
      },
    });

    expect(await read('dst/IMG.xmp')).toBe('old edit');
    expect((await fs.readdir(abs('dst'))).sort()).toEqual(['IMG.HEIC', 'IMG.xmp']);
  });

  test('a committed Replace clears the old edit without a hidden copy', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('dst/IMG.HEIC', 'old');
    await write('dst/IMG.xmp', 'old edit');

    expect((await replace({})).kind).toBe('relocated');

    expect((await fs.readdir(abs('dst'))).sort()).toEqual(['IMG.HEIC']);
  });

  test('where hard links are refused, a rollback still restores the displaced photo', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('dst/IMG.HEIC', 'old');
    const link = spyOn(fs, 'link').mockRejectedValue(
      Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
    );
    try {
      await replace({
        onVerified: async () => {
          throw new Error('repoint failed');
        },
      });
    } finally {
      link.mockRestore();
    }

    expect(await read('dst/IMG.HEIC')).toBe('old');
    expect((await fs.readdir(abs('dst'))).sort()).toEqual(['IMG.HEIC']);
  });
});
