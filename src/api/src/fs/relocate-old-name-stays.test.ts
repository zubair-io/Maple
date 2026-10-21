/**
 * A photo never leaves a folder where its pre-#5021 old-name edit stays behind
 * (#5063): the migration looks for that edit only beside the photo, so a move
 * whose old-name edit can't follow keeps the original. Real files in a temp dir.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { relocateFile } from './relocate.ts';
import * as ownership from './sidecar-ownership.ts';

const maple = (label: string) =>
  `<x:xmpmeta xmlns:papp="http://ns.justmaple.app/photo/1.0/">${label}</x:xmpmeta>`;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-old-name-stays-'));
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

const move = (hooks: Pick<Parameters<typeof relocateFile>[0], 'onVerified'>) =>
  relocateFile({
    sourceAbsPath: abs('a/IMG.HEIC'),
    destAbsPath: abs('b/IMG.HEIC'),
    mode: 'move',
    collision: 'auto-suffix',
    ...hooks,
  });

describe('relocate keeps the photo with an old-name edit that stays behind (#5063)', () => {
  test('a late old-name edit that cannot be carried keeps the photo at the old path', async () => {
    await write('a/IMG.HEIC', 'pixels');
    const realPublish = ownership.publishSidecarSnapshot;
    const publish = spyOn(ownership, 'publishSidecarSnapshot').mockImplementation(
      async (source, dest, publications) =>
        String(source).endsWith('IMG.HEIC.xmp')
          ? Promise.reject(new Error('EIO'))
          : realPublish(source, dest, publications),
    );
    try {
      const outcome = await move({
        onVerified: () => write('a/IMG.HEIC.xmp', maple('late backup edit')),
      });

      expect(outcome.kind).toBe('relocated');
    } finally {
      publish.mockRestore();
    }
    expect(await read('b/IMG.HEIC')).toBe('pixels');
    expect(await read('a/IMG.HEIC')).toBe('pixels');
    expect(await read('a/IMG.HEIC.xmp')).toBe(maple('late backup edit'));
  });

  test('a carried old-name edit whose source is kept on settle keeps the photo too', async () => {
    await write('a/IMG.HEIC', 'pixels');
    await write('a/IMG.HEIC.xmp', maple('backup edit'));

    const outcome = await move({
      onVerified: async () => {
        await write('a/IMG.HEIC.xmp', maple('saved at the old path'));
        await write('b/IMG.HEIC.xmp', maple('saved at the new path'));
      },
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('a/IMG.HEIC.xmp')).toBe(maple('saved at the old path'));
    expect(await read('a/IMG.HEIC')).toBe('pixels');
  });

  test('a move whose old-name edit followed it still removes the original', async () => {
    await write('a/IMG.HEIC', 'pixels');
    await write('a/IMG.HEIC.xmp', maple('backup edit'));

    const outcome = await move({});

    expect(outcome.kind).toBe('relocated');
    expect(await read('b/IMG.HEIC.xmp')).toBe(maple('backup edit'));
    expect(await read('a/IMG.HEIC')).toBeNull();
  });
});
