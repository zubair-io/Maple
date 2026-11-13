/**
 * A pre-#5021 old-name edit that stays at the old path after a move (#5063)
 * follows the photo as a `(conflict from move)` copy, and the original goes;
 * only when that copy can't be made does the original stay with the edit. A
 * kept original in the library would bring a trashed photo back (#5075).
 * Real files in a temp dir.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { relocateFile } from './relocate.ts';
import { moveFileToTrash, moveToTrash } from './trash.ts';
import * as xmpConflict from './xmp-conflict.ts';
import * as publishing from './relocate-publish.ts';
import { serializeSidecarWrite } from './sidecar-write-order.ts';
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

describe('an old-name edit that stays behind after a move (#5063, #5075)', () => {
  test('a late old-name edit that cannot be carried follows the photo as a conflict copy', async () => {
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
    expect(await read('b/IMG (conflict from move).xmp')).toBe(maple('late backup edit'));
    expect(await read('a/IMG.HEIC')).toBeNull();
    expect(await read('a/IMG.HEIC.xmp')).toBeNull();
  });

  test('a carried old-name edit whose source is kept on settle follows as a conflict copy', async () => {
    await write('a/IMG.HEIC', 'pixels');
    await write('a/IMG.HEIC.xmp', maple('backup edit'));

    const outcome = await move({
      onVerified: async () => {
        await write('a/IMG.HEIC.xmp', maple('saved at the old path'));
        await write('b/IMG.HEIC.xmp', maple('saved at the new path'));
      },
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('b/IMG.HEIC.xmp')).toBe(maple('saved at the new path'));
    expect(await read('b/IMG (conflict from move).xmp')).toBe(maple('saved at the old path'));
    expect(await read('a/IMG.HEIC.xmp')).toBeNull();
    expect(await read('a/IMG.HEIC')).toBeNull();
  });

  test('an old-name edit that can follow neither way keeps the photo at the old path', async () => {
    await write('a/IMG.HEIC', 'pixels');
    await write('a/IMG.HEIC.xmp', maple('backup edit'));
    const pick = spyOn(xmpConflict, 'pickFreeConflictPath').mockRejectedValue(new Error('EIO'));
    try {
      const outcome = await move({
        onVerified: async () => {
          await write('a/IMG.HEIC.xmp', maple('saved at the old path'));
          await write('b/IMG.HEIC.xmp', maple('saved at the new path'));
        },
      });

      expect(outcome.kind).toBe('relocated');
    } finally {
      pick.mockRestore();
    }
    expect(await read('a/IMG.HEIC.xmp')).toBe(maple('saved at the old path'));
    expect(await read('a/IMG.HEIC')).toBe('pixels');
  });

  test('Trash never leaves the original in the library for a stayed-behind edit', async () => {
    await write('2024/IMG.HEIC', 'pixels');
    await write('2024/IMG.HEIC.xmp', maple('backup edit'));

    const trashed = await moveToTrash(
      abs('2024/IMG.HEIC'),
      root,
      undefined,
      undefined,
      async () => {
        await write('2024/IMG.HEIC.xmp', maple('saved at the old path'));
        await write('.maple/trash/2024/IMG.HEIC.xmp', maple('saved in the trash'));
      },
    );

    expect(trashed.kind).toBe('ok');
    expect(await read('2024/IMG.HEIC')).toBeNull();
    expect(await read('2024/IMG.HEIC.xmp')).toBeNull();
    expect(await read('.maple/trash/2024/IMG (conflict from move).xmp')).toBe(
      maple('saved at the old path'),
    );
  });

  test('a move whose old-name edit followed it still removes the original', async () => {
    await write('a/IMG.HEIC', 'pixels');
    await write('a/IMG.HEIC.xmp', maple('backup edit'));

    const outcome = await move({});

    expect(outcome.kind).toBe('relocated');
    expect(await read('b/IMG.HEIC.xmp')).toBe(maple('backup edit'));
    expect(await read('a/IMG.HEIC')).toBeNull();
  });

  test('a lease lost after the sidecars settle keeps the original photo', async () => {
    await write('a/IMG.HEIC', 'pixels');
    await write('a/IMG.xmp', 'edit');

    await relocateFile({
      sourceAbsPath: abs('a/IMG.HEIC'),
      destAbsPath: abs('b/IMG.HEIC'),
      mode: 'move',
      collision: 'auto-suffix',
      // Lost once the sidecar has settled, so only the check before the photo sees it.
      beforeSourceDelete: async () => {
        if ((await read('a/IMG.xmp')) === null) throw new Error('lease expired');
      },
    });

    expect(await read('b/IMG.xmp')).toBe('edit');
    expect(await read('a/IMG.HEIC')).toBe('pixels');
  });

  test('a lease lost while a left-behind edit was being carried keeps the original photo', async () => {
    await write('a/IMG.HEIC', 'pixels');
    await write('a/IMG.HEIC.xmp', maple('backup edit'));

    await relocateFile({
      sourceAbsPath: abs('a/IMG.HEIC'),
      destAbsPath: abs('b/IMG.HEIC'),
      mode: 'move',
      collision: 'auto-suffix',
      onVerified: async () => {
        await write('a/IMG.HEIC.xmp', maple('saved at the old path'));
        await write('b/IMG.HEIC.xmp', maple('saved at the new path'));
      },
      // Lost only once the left-behind edit has followed as a conflict copy.
      beforeSourceDelete: async () => {
        if ((await read('b/IMG (conflict from move).xmp')) !== null)
          throw new Error('lease expired');
      },
    });

    expect(await read('b/IMG (conflict from move).xmp')).toBe(maple('saved at the old path'));
    expect(await read('a/IMG.HEIC')).toBe('pixels');
  });

  test('a move that carries no sidecars leaves a full-name .xmp alone', async () => {
    await write('2024/notes.txt', 'plain file');
    await write('2024/notes.txt.xmp', maple('not this file'));

    const trashed = await moveFileToTrash(abs('2024/notes.txt'), root);

    expect(trashed.kind).toBe('ok');
    expect(await read('2024/notes.txt')).toBeNull();
    expect(await read('2024/notes.txt.xmp')).toBe(maple('not this file'));
    expect(await read('.maple/trash/2024/notes (conflict from move).xmp')).toBeNull();
  });

  test("a file that took the old-name slot while the carry waited isn't copied or removed", async () => {
    await write('a/IMG.HEIC', 'pixels');
    const legacy = abs('a/IMG.HEIC.xmp');
    const darktable = '<x:xmpmeta xmlns:darktable="http://darktable.sf.net/"/>';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let holder: Promise<void> | null = null;
    const realPublish = ownership.publishSidecarSnapshot;
    const publish = spyOn(ownership, 'publishSidecarSnapshot').mockImplementation(
      async (source, dest, publications) =>
        String(source).endsWith('IMG.HEIC.xmp')
          ? Promise.reject(new Error('EIO'))
          : realPublish(source, dest, publications),
    );
    try {
      const moving = move({
        onVerified: async () => {
          await write('a/IMG.HEIC.xmp', maple('late backup edit'));
          holder = serializeSidecarWrite(legacy, () => gate);
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await write('a/IMG.HEIC.xmp', darktable);
      release();
      await holder;
      expect((await moving).kind).toBe('relocated');
    } finally {
      publish.mockRestore();
    }

    expect(await read('b/IMG (conflict from move).xmp')).toBeNull();
    expect(await read('a/IMG.HEIC.xmp')).toBe(darktable);
  });

  test('a file another app swapped in just before the removal is put back, not deleted', async () => {
    await write('a/IMG.HEIC', 'pixels');
    await write('a/IMG.HEIC.xmp', maple('backup edit'));
    const darktable = '<x:xmpmeta xmlns:darktable="http://darktable.sf.net/"/>';
    const realRename = fs.rename;
    const rename = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === abs('a/IMG.HEIC.xmp'))
        await fs.writeFile(abs('a/IMG.HEIC.xmp'), darktable);
      return realRename(from, to);
    });
    try {
      await move({
        onVerified: async () => {
          await write('a/IMG.HEIC.xmp', maple('saved at the old path'));
          await write('b/IMG.HEIC.xmp', maple('saved at the new path'));
        },
      });
    } finally {
      rename.mockRestore();
    }

    expect(await read('a/IMG.HEIC.xmp')).toBe(darktable);
    expect(await read('b/IMG (conflict from move).xmp')).toBe(maple('saved at the old path'));
  });

  test('a swapped-in file that cannot be put back keeps the original photo', async () => {
    await write('a/IMG.HEIC', 'pixels');
    await write('a/IMG.HEIC.xmp', maple('backup edit'));
    const legacy = abs('a/IMG.HEIC.xmp');
    const realRename = fs.rename;
    const rename = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === legacy) await fs.writeFile(legacy, maple('newer'));
      return realRename(from, to);
    });
    const realPublish = publishing.publishExclusive;
    const putBack = spyOn(publishing, 'publishExclusive').mockImplementation(
      async (tmp, destination) =>
        destination === legacy ? Promise.reject(new Error('EIO')) : realPublish(tmp, destination),
    );
    const realPick = xmpConflict.pickFreeConflictPath;
    const pick = spyOn(xmpConflict, 'pickFreeConflictPath')
      .mockImplementationOnce(realPick)
      .mockRejectedValue(new Error('EIO'));
    try {
      await move({
        onVerified: async () => {
          await write('a/IMG.HEIC.xmp', maple('saved at the old path'));
          await write('b/IMG.HEIC.xmp', maple('saved at the new path'));
        },
      });
    } finally {
      rename.mockRestore();
      putBack.mockRestore();
      pick.mockRestore();
    }

    expect(await read('a/IMG.HEIC')).toBe('pixels');
  });
});
