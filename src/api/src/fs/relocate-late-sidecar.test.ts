/**
 * A sidecar created after a move listed the photo's sidecars, such as a
 * first-ever backup send or web save, still travels with the photo (#5062).
 * Real files in a temp library.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { relocateFile } from './relocate.ts';
import * as ownership from './sidecar-ownership.ts';
import * as xmpConflict from './xmp-conflict.ts';
import { moveToTrash } from './trash.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-late-sidecar-'));
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

describe('a sidecar created mid-move (#5062)', () => {
  test('trash carries a sidecar first written while the photo was being moved', async () => {
    await write('2024/IMG.HEIC', 'pixels');

    const trashed = await moveToTrash(abs('2024/IMG.HEIC'), root, () =>
      write('2024/IMG.xmp', 'first edit'),
    );

    expect(trashed.kind).toBe('ok');
    expect(await read('2024/IMG.xmp')).toBeNull();
    expect(await read('.maple/trash/2024/IMG.xmp')).toBe('first edit');
  });

  test('a sidecar written after the copy but before the repoint follows a move', async () => {
    await write('a/IMG.HEIC', 'pixels');

    const outcome = await relocateFile({
      sourceAbsPath: abs('a/IMG.HEIC'),
      destAbsPath: abs('b/IMG.HEIC'),
      mode: 'move',
      collision: 'auto-suffix',
      onVerified: () => write('a/IMG.xmp', 'late edit'),
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('a/IMG.xmp')).toBeNull();
    expect(await read('b/IMG.xmp')).toBe('late edit');
  });

  test("a late sidecar follows the photo's suffixed name and never touches a sibling's", async () => {
    await write('a/IMG.HEIC', 'pixels');
    await write('b/IMG.JPG', 'sibling');
    await write('b/IMG.xmp', "the sibling's edit");

    const outcome = await relocateFile({
      sourceAbsPath: abs('a/IMG.HEIC'),
      destAbsPath: abs('b/IMG.HEIC'),
      mode: 'move',
      collision: 'auto-suffix',
      onDestinationPrepared: () => write('a/IMG.xmp', 'late edit'),
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('b/IMG.xmp')).toBe("the sibling's edit");
    expect(await read('b/IMG.1.xmp')).toBe('late edit');
    expect(await read('a/IMG.xmp')).toBeNull();
  });

  test('a copy leaves a late sidecar where it is', async () => {
    await write('a/IMG.HEIC', 'pixels');

    const outcome = await relocateFile({
      sourceAbsPath: abs('a/IMG.HEIC'),
      destAbsPath: abs('b/IMG.HEIC'),
      mode: 'copy',
      collision: 'auto-suffix',
      onDestinationPrepared: () => write('a/IMG.xmp', 'late edit'),
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('a/IMG.xmp')).toBe('late edit');
  });

  test('a late sidecar that loses its name to a save at the new path lands as a conflict copy', async () => {
    await write('a/IMG.HEIC', 'pixels');

    const outcome = await relocateFile({
      sourceAbsPath: abs('a/IMG.HEIC'),
      destAbsPath: abs('b/IMG.HEIC'),
      mode: 'move',
      collision: 'auto-suffix',
      onVerified: async () => {
        await write('a/IMG.xmp', 'late edit at the old path');
        await write('b/IMG.xmp', 'save at the new path');
      },
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('b/IMG.xmp')).toBe('save at the new path');
    expect(await read('b/IMG (conflict from move).xmp')).toBe('late edit at the old path');
    expect(await read('a/IMG.xmp')).toBeNull();
  });

  test("an extension-only rename leaves a late sidecar as the photo's own", async () => {
    await write('a/X.CR3', 'pixels');

    const outcome = await relocateFile({
      sourceAbsPath: abs('a/X.CR3'),
      destAbsPath: abs('a/X.DNG'),
      mode: 'move',
      collision: 'auto-suffix',
      onVerified: () => write('a/X.xmp', 'late edit'),
    });

    expect(outcome.kind).toBe('relocated');
    expect((await fs.readdir(abs('a'))).sort()).toEqual(['X.DNG', 'X.xmp']);
    expect(await read('a/X.xmp')).toBe('late edit');
  });

  test('a late sidecar joins identical bytes already at its destination', async () => {
    await write('a/IMG.HEIC', 'pixels');

    const outcome = await relocateFile({
      sourceAbsPath: abs('a/IMG.HEIC'),
      destAbsPath: abs('b/IMG.HEIC'),
      mode: 'move',
      collision: 'auto-suffix',
      onVerified: async () => {
        await write('a/IMG.xmp', 'same edit');
        await write('b/IMG.xmp', 'same edit');
      },
    });

    expect(outcome.kind).toBe('relocated');
    expect((await fs.readdir(abs('b'))).sort()).toEqual(['IMG.HEIC', 'IMG.xmp']);
    expect(await read('a/IMG.xmp')).toBeNull();
  });

  test('a late sidecar whose join loses a race still lands as a conflict copy', async () => {
    await write('a/IMG.HEIC', 'pixels');
    const join = spyOn(ownership, 'joinCarriedSidecar').mockImplementationOnce(async (_s, dest) => {
      throw new ownership.SidecarCollisionError(dest);
    });
    try {
      const outcome = await relocateFile({
        sourceAbsPath: abs('a/IMG.HEIC'),
        destAbsPath: abs('b/IMG.HEIC'),
        mode: 'move',
        collision: 'auto-suffix',
        onVerified: async () => {
          await write('a/IMG.xmp', 'same edit');
          await write('b/IMG.xmp', 'same edit');
        },
      });

      expect(outcome.kind).toBe('relocated');
      expect(await read('b/IMG (conflict from move).xmp')).toBe('same edit');
      expect(await read('a/IMG.xmp')).toBeNull();
    } finally {
      join.mockRestore();
    }
  });

  test('a move rolled back before its repoint withdraws a late sidecar it published', async () => {
    await write('a/IMG.HEIC', 'pixels');
    let calls = 0;

    const outcome = await relocateFile({
      sourceAbsPath: abs('a/IMG.HEIC'),
      destAbsPath: abs('b/IMG.HEIC'),
      mode: 'move',
      collision: 'auto-suffix',
      onDestinationPrepared: () => write('a/IMG.xmp', 'late edit'),
      beforeSourceDelete: async () => {
        calls += 1;
        if (calls === 2) throw new Error('lease expired');
      },
    });

    expect(outcome.kind).toBe('error');
    expect(await read('b/IMG.xmp')).toBeNull();
    expect(await read('a/IMG.xmp')).toBe('late edit');
    expect(await read('a/IMG.HEIC')).toBe('pixels');
  });

  test('a late conflict name taken in a race moves on to the next free one', async () => {
    await write('a/IMG.HEIC', 'pixels');
    const raced = abs('b/IMG (conflict from move).xmp');
    const pick = spyOn(xmpConflict, 'pickFreeConflictPath').mockImplementationOnce(async () => {
      await write('b/IMG (conflict from move).xmp', 'another writer');
      return raced;
    });
    try {
      const outcome = await relocateFile({
        sourceAbsPath: abs('a/IMG.HEIC'),
        destAbsPath: abs('b/IMG.HEIC'),
        mode: 'move',
        collision: 'auto-suffix',
        onVerified: async () => {
          await write('a/IMG.xmp', 'late edit');
          await write('b/IMG.xmp', 'save at the new path');
        },
      });

      expect(outcome.kind).toBe('relocated');
      expect(await read('b/IMG (conflict from move).xmp')).toBe('another writer');
      expect(await read('b/IMG (conflict from move) (2).xmp')).toBe('late edit');
      expect(await read('a/IMG.xmp')).toBeNull();
    } finally {
      pick.mockRestore();
    }
  });

  const maple = (label: string) =>
    `<x:xmpmeta xmlns:papp="http://ns.justmaple.app/photo/1.0/">${label}</x:xmpmeta>`;

  test("a late old-name edit isn't kept behind for a RAW+JPEG sibling", async () => {
    await write('a/IMG.CR3', 'raw');
    await write('a/IMG.JPG', 'jpeg');

    const outcome = await relocateFile({
      sourceAbsPath: abs('a/IMG.CR3'),
      destAbsPath: abs('b/IMG.CR3'),
      mode: 'move',
      collision: 'auto-suffix',
      onVerified: () => write('a/IMG.CR3.xmp', maple('backup edit')),
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('b/IMG.CR3.xmp')).toBe(maple('backup edit'));
    expect(await read('a/IMG.CR3.xmp')).toBeNull();
  });

  test('a late old-name edit never lands on a name another file at the destination owns', async () => {
    await write('a/IMG.HEIC', 'pixels');
    await write('b/IMG.HEIC.JPG', 'export');

    const outcome = await relocateFile({
      sourceAbsPath: abs('a/IMG.HEIC'),
      destAbsPath: abs('b/IMG.HEIC'),
      mode: 'move',
      collision: 'auto-suffix',
      onVerified: () => write('a/IMG.HEIC.xmp', maple('backup edit')),
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('b/IMG.HEIC.xmp')).toBeNull();
    expect(await read('b/IMG (conflict from move).xmp')).toBe(maple('backup edit'));
  });
});
