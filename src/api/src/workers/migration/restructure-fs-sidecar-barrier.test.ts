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
import { finalize, planAndPlace, type PlacePlan } from './restructure-fs.ts';

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
});
