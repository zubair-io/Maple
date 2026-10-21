/**
 * Refile carries a photo's sidecars under the sidecar write barrier (#5061): a
 * save that lands on the old `IMG.xmp` between the copy and the cleanup is
 * carried to the new path, never deleted. Real files in a temp library.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from '../../fs/mirrored.ts';
import { serializeSidecarWrite } from '../../fs/sidecar-write-order.ts';
import * as xmpConflict from '../../fs/xmp-conflict.ts';
import { finalize, planAndPlace, type PlacePlan } from './restructure-fs.ts';
import { carryLateRefileSidecars } from './refile-sidecar.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-barrier-'));
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

async function place(): Promise<PlacePlan> {
  await write('2024/03-15/IMG.HEIC', 'pixels');
  await write('2024/03-15/IMG.xmp', 'edit 1');
  return planAndPlace({
    libRoot: root,
    oldDir: '2024/03-15',
    filename: 'IMG.HEIC',
    newDir: '2024',
    renderedRelOld: null,
  });
}

const cleanUp = (plan: PlacePlan) =>
  finalize({
    libRoot: root,
    oldDirAbs: plan.oldDirAbs,
    mapleId: undefined,
    filename: 'IMG.HEIC',
    sourcesToDelete: plan.sourcesToDelete,
    carriedSidecars: plan.carriedSidecars,
  });

describe('refile sidecar barrier (#5061)', () => {
  test('a save on the old sidecar between copy and cleanup is carried to the new path', async () => {
    const plan = await place();
    await write('2024/03-15/IMG.xmp', 'edit 2');

    await cleanUp(plan);

    expect(await read('2024/IMG.xmp')).toBe('edit 2');
    expect(await read('2024/03-15/IMG.xmp')).toBeNull();
  });

  test('when both ends changed, the late save becomes a conflict copy beside the photo', async () => {
    const plan = await place();
    await write('2024/03-15/IMG.xmp', 'late save at the old path');
    await write('2024/IMG.xmp', 'save at the new path');

    await cleanUp(plan);

    expect(await read('2024/IMG.xmp')).toBe('save at the new path');
    expect(await read('2024/IMG (conflict from refile).xmp')).toBe('late save at the old path');
    expect(await read('2024/03-15/IMG.xmp')).toBeNull();
  });

  test('a late save the new path already holds needs no conflict copy', async () => {
    const plan = await place();
    await write('2024/03-15/IMG.xmp', 'same edit at both ends');
    await write('2024/IMG.xmp', 'same edit at both ends');

    await cleanUp(plan);

    expect((await fs.readdir(abs('2024'))).sort()).toEqual(['IMG.HEIC', 'IMG.xmp']);
  });

  // Root reads a mode-000 file anyway, so there is nothing to refuse.
  test.skipIf(process.getuid?.() === 0)(
    'a sidecar that fails to copy reverts every copy, so a retry starts clean',
    async () => {
      await write('2024/03-15/IMG.HEIC', 'pixels');
      await write('2024/03-15/IMG.xmp', 'edit');
      await fs.chmod(abs('2024/03-15/IMG.xmp'), 0o000);
      try {
        await expect(
          planAndPlace({
            libRoot: root,
            oldDir: '2024/03-15',
            filename: 'IMG.HEIC',
            newDir: '2024',
            renderedRelOld: null,
          }),
        ).rejects.toThrow();
        expect((await fs.readdir(abs('2024'))).sort()).toEqual(['03-15']);
      } finally {
        await fs.chmod(abs('2024/03-15/IMG.xmp'), 0o644);
      }
    },
  );

  test('a symlinked sidecar stays where it is and the photo still moves, once', async () => {
    await write('2024/03-15/IMG.HEIC', 'pixels');
    await write('elsewhere/target.xmp', 'linked');
    await fs.symlink(abs('elsewhere/target.xmp'), abs('2024/03-15/IMG.xmp'));
    const args = {
      libRoot: root,
      oldDir: '2024/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024',
      renderedRelOld: null,
    };

    const plan = await planAndPlace(args);

    expect(plan.newRelPath).toBe('2024/IMG.HEIC');
    expect(plan.carriedSidecars).toEqual([]);
    expect(await read('2024/IMG.xmp')).toBeNull();
    expect((await fs.lstat(abs('2024/03-15/IMG.xmp'))).isSymbolicLink()).toBe(true);
  });

  test('cleanup waits for a save holding the old sidecar barrier, then carries it', async () => {
    const plan = await place();
    let cleaned: Promise<void> | undefined;
    await serializeSidecarWrite(abs('2024/03-15/IMG.xmp'), async () => {
      cleaned = cleanUp(plan);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await fs.writeFile(abs('2024/03-15/IMG.xmp'), 'edit inside the barrier');
    });
    await cleaned;

    expect(await read('2024/IMG.xmp')).toBe('edit inside the barrier');
    expect(await read('2024/03-15/IMG.xmp')).toBeNull();
  });

  test('the copy waits for a save holding the barrier, so it copies the saved bytes', async () => {
    await write('2024/03-15/IMG.HEIC', 'pixels');
    await write('2024/03-15/IMG.xmp', 'edit 1');
    let placed: Promise<PlacePlan> | undefined;
    await serializeSidecarWrite(abs('2024/03-15/IMG.xmp'), async () => {
      placed = planAndPlace({
        libRoot: root,
        oldDir: '2024/03-15',
        filename: 'IMG.HEIC',
        newDir: '2024',
        renderedRelOld: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await fs.writeFile(abs('2024/03-15/IMG.xmp'), 'edit 2');
    });
    await cleanUp(await placed!);

    expect(await read('2024/IMG.xmp')).toBe('edit 2');
  });

  test('a late save whose replace fails leaves no temp file and keeps the source', async () => {
    const plan = await place();
    await write('2024/03-15/IMG.xmp', 'edit 2');
    const rename = spyOn(fs, 'rename').mockRejectedValueOnce(new Error('EBUSY'));
    try {
      await cleanUp(plan);
    } finally {
      rename.mockRestore();
    }

    expect((await fs.readdir(abs('2024'))).filter((name) => name.includes('.tmp.'))).toEqual([]);
    expect(await read('2024/03-15/IMG.xmp')).toBe('edit 2');
  });

  test("another process's save landing on the new path just before the swap is kept", async () => {
    const plan = await place();
    await write('2024/03-15/IMG.xmp', 'edit 2');
    const realRename = fs.rename;
    const rename = spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      await fs.writeFile(abs('2024/IMG.xmp'), 'api save');
      return realRename(from, to);
    });
    try {
      await cleanUp(plan);
    } finally {
      rename.mockRestore();
    }

    expect(await read('2024/IMG.xmp')).toBe('api save');
    expect(await read('2024/IMG (conflict from refile).xmp')).toBe('edit 2');
    expect(await read('2024/03-15/IMG.xmp')).toBeNull();
    expect((await fs.readdir(abs('2024'))).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  test('a conflict name taken in a race moves on to the next free one', async () => {
    const plan = await place();
    await write('2024/03-15/IMG.xmp', 'late save at the old path');
    await write('2024/IMG.xmp', 'save at the new path');
    const raced = abs('2024/IMG (conflict from refile).xmp');
    const pick = spyOn(xmpConflict, 'pickFreeConflictPath').mockImplementationOnce(async () => {
      await fs.writeFile(raced, 'another writer');
      return raced;
    });
    try {
      await cleanUp(plan);
    } finally {
      pick.mockRestore();
    }

    expect(await read('2024/IMG (conflict from refile).xmp')).toBe('another writer');
    expect(await read('2024/IMG (conflict from refile) (2).xmp')).toBe('late save at the old path');
    expect(await read('2024/03-15/IMG.xmp')).toBeNull();
  });

  test('a rollback keeps a sidecar another writer saved over the one refile published', async () => {
    await write('2024/03-15/IMG.HEIC', 'pixels');
    await write('2024/03-15/IMG.xmp', 'edit 1');
    await write('2024/03-15/IMG-rendered.jpg', 'render');
    const realCopy = fs.copyFile;
    let copies = 0;
    const copy = spyOn(fs, 'copyFile').mockImplementation(async (src, dst, mode) => {
      copies += 1;
      if (copies < 2) return realCopy(src, dst, mode);
      await fs.writeFile(abs('2024/IMG.xmp.saving'), 'newer save');
      await fs.rename(abs('2024/IMG.xmp.saving'), abs('2024/IMG.xmp'));
      throw new Error('EIO');
    });
    try {
      await expect(
        planAndPlace({
          libRoot: root,
          oldDir: '2024/03-15',
          filename: 'IMG.HEIC',
          newDir: '2024',
          renderedRelOld: '2024/03-15/IMG-rendered.jpg',
        }),
      ).rejects.toThrow('EIO');
    } finally {
      copy.mockRestore();
    }

    expect(await read('2024/IMG.xmp')).toBe('newer save');
    expect(await read('2024/IMG.HEIC')).toBeNull();
  });

  test('a rollback keeps a photo another writer replaced at the new path', async () => {
    await write('2024/03-15/IMG.HEIC', 'pixels');
    await write('2024/03-15/IMG-rendered.jpg', 'render');
    const realLink = fs.link;
    let links = 0;
    const link = spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      links += 1;
      if (links < 2) return realLink(src, dst);
      await fs.writeFile(abs('2024/IMG.HEIC.saving'), 'another writer');
      await fs.rename(abs('2024/IMG.HEIC.saving'), abs('2024/IMG.HEIC'));
      throw new Error('EIO');
    });
    try {
      await expect(
        planAndPlace({
          libRoot: root,
          oldDir: '2024/03-15',
          filename: 'IMG.HEIC',
          newDir: '2024',
          renderedRelOld: '2024/03-15/IMG-rendered.jpg',
        }),
      ).rejects.toThrow('EIO');
    } finally {
      link.mockRestore();
    }

    expect(await read('2024/IMG.HEIC')).toBe('another writer');
    expect(await read('2024/03-15/IMG.HEIC')).toBe('pixels');
  });

  test('a photo with a long file name still refiles, with its sidecar', async () => {
    const name = `${'x'.repeat(240)}.HEIC`;
    await write(`2024/03-15/${name}`, 'pixels');
    await write(`2024/03-15/${'x'.repeat(240)}.xmp`, 'edit');

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/03-15',
      filename: name,
      newDir: '2024',
      renderedRelOld: null,
    });

    expect(plan.newRelPath).toBe(`2024/${name}`);
    expect(await read(`2024/${name}`)).toBe('pixels');
    expect(await read(`2024/${'x'.repeat(240)}.xmp`)).toBe('edit');
  });

  test('a sidecar first written after refile listed the photo is carried after the repoint', async () => {
    await write('2024/03-15/IMG.HEIC', 'pixels');
    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024',
      renderedRelOld: null,
    });
    await write('2024/03-15/IMG.xmp', 'first edit');

    const late = await carryLateRefileSidecars(
      abs('2024/03-15/IMG.HEIC'),
      abs('2024/IMG.HEIC'),
      plan.carriedSidecars,
    );
    await finalize({
      libRoot: root,
      oldDirAbs: plan.oldDirAbs,
      mapleId: undefined,
      filename: 'IMG.HEIC',
      sourcesToDelete: plan.sourcesToDelete,
      carriedSidecars: [...plan.carriedSidecars, ...late],
    });

    expect(await read('2024/IMG.xmp')).toBe('first edit');
    expect(await read('2024/03-15/IMG.xmp')).toBeNull();
  });

  test('a late sidecar a same-stem sibling still uses stays with it', async () => {
    await write('2024/03-15/IMG.CR3', 'raw');
    await write('2024/03-15/IMG.JPG', 'jpeg');
    await write('2024/03-15/IMG.xmp', 'sibling edit');

    const late = await carryLateRefileSidecars(abs('2024/03-15/IMG.CR3'), abs('2024/IMG.CR3'), []);

    expect(late).toEqual([]);
    expect(await read('2024/03-15/IMG.xmp')).toBe('sibling edit');
    expect(await read('2024/IMG.xmp')).toBeNull();
  });

  test('a late sidecar whose conflict name is taken first picks another one', async () => {
    await write('2024/03-15/IMG.HEIC', 'pixels');
    await write('2024/IMG.xmp', 'already there');
    await write('2024/03-15/IMG.xmp', 'late edit');
    const realPick = xmpConflict.pickFreeConflictPath;
    const pick = spyOn(xmpConflict, 'pickFreeConflictPath').mockImplementationOnce(
      async (primary, label) => {
        const picked = await realPick(primary, label);
        await write(path.relative(root, picked), 'raced');
        return picked;
      },
    );
    try {
      const late = await carryLateRefileSidecars(
        abs('2024/03-15/IMG.HEIC'),
        abs('2024/IMG.HEIC'),
        [],
      );

      expect(late).toHaveLength(1);
      expect(await read(path.relative(root, late[0]!.dest))).toBe('late edit');
    } finally {
      pick.mockRestore();
    }
    expect(await read('2024/IMG.xmp')).toBe('already there');
  });

  test('a temp whose verification read fails is removed, and the source kept', async () => {
    const plan = await place();
    await write('2024/03-15/IMG.xmp', 'edit 2');
    const realRead = fs.readFile;
    const readFile = spyOn(fs, 'readFile').mockImplementation(((file: string, ...rest: []) =>
      String(file).includes('.tmp.')
        ? Promise.reject(new Error('EIO'))
        : realRead(file, ...rest)) as typeof fs.readFile);
    try {
      await cleanUp(plan).catch(() => {});
    } finally {
      readFile.mockRestore();
    }

    expect((await fs.readdir(abs('2024'))).filter((name) => name.includes('.tmp.'))).toEqual([]);
    expect(await read('2024/03-15/IMG.xmp')).toBe('edit 2');
  });

  test('a sidecar first written after a dedupe listed the photo follows it to the survivor (#5069)', async () => {
    await write('2024/03-15/IMG.HEIC', 'pixels');
    await write('2024/IMG.HEIC', 'pixels');
    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024',
      renderedRelOld: null,
    });
    expect(plan.outcome).toBe('deduped');
    await write('2024/03-15/IMG.xmp', 'first edit');

    const late = await carryLateRefileSidecars(
      abs('2024/03-15/IMG.HEIC'),
      abs(plan.newRelPath),
      plan.carriedSidecars,
    );
    await finalize({
      libRoot: root,
      oldDirAbs: plan.oldDirAbs,
      mapleId: undefined,
      filename: 'IMG.HEIC',
      sourcesToDelete: plan.sourcesToDelete,
      carriedSidecars: [...plan.carriedSidecars, ...late],
    });

    expect(await read('2024/IMG.xmp')).toBe('first edit');
    expect(await read('2024/03-15/IMG.xmp')).toBeNull();
  });
});
