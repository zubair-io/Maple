/**
 * Refile follows the shared-sidecar rules (#4692, #5066): a sidecar a same-stem
 * sibling still uses is copied, never taken, and an occupied canonical sidecar
 * at the destination is a collision for the whole photo. Real files in a temp library.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from '../../fs/mirrored.ts';
import { finalize, planAndPlace } from './restructure-fs.ts';

const caseSensitive = await (async () => {
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-case-probe-'));
  try {
    await fs.writeFile(path.join(probe, 'a'), '');
    return !(await fs.lstat(path.join(probe, 'A')).then(
      () => true,
      () => false,
    ));
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
})();

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-shared-'));
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

async function refile(filename: string): Promise<string> {
  const plan = await planAndPlace({
    libRoot: root,
    oldDir: '2024/03-15',
    filename,
    newDir: '2024',
    renderedRelOld: null,
    liveVideoRelOld: null,
  });
  await finalize({
    libRoot: root,
    oldDirAbs: plan.oldDirAbs,
    mapleId: undefined,
    filename,
    sourcesToDelete: plan.sourcesToDelete,
    carriedSidecars: plan.carriedSidecars,
  });
  return plan.newRelPath;
}

describe('refile and the shared-sidecar rules (#5066)', () => {
  test('rule 1: a sidecar a same-stem sibling still uses is copied and stays for it', async () => {
    await write('2024/03-15/IMG.HEIC', 'heic');
    await write('2024/03-15/IMG.JPG', 'jpeg');
    await write('2024/03-15/IMG.xmp', 'shared edit');

    expect(await refile('IMG.HEIC')).toBe('2024/IMG.HEIC');

    expect(await read('2024/IMG.xmp')).toBe('shared edit');
    expect(await read('2024/03-15/IMG.xmp')).toBe('shared edit');
  });

  test('rule 2: an occupied canonical sidecar at the destination moves the whole photo on', async () => {
    await write('2024/03-15/IMG.HEIC', 'heic');
    await write('2024/03-15/IMG.xmp', 'its edit');
    await write('2024/IMG.xmp', 'a stray edit');

    expect(await refile('IMG.HEIC')).toBe('2024/IMG.1.HEIC');

    expect(await read('2024/IMG.1.xmp')).toBe('its edit');
    expect(await read('2024/IMG.xmp')).toBe('a stray edit');
    expect(await read('2024/03-15/IMG.xmp')).toBeNull();
  });

  test('both photos of a pair that shares IMG.xmp refile, the second joining the copy', async () => {
    await write('2024/03-15/IMG.HEIC', 'heic');
    await write('2024/03-15/IMG.JPG', 'jpeg');
    await write('2024/03-15/IMG.xmp', 'shared edit');

    expect(await refile('IMG.HEIC')).toBe('2024/IMG.HEIC');
    expect(await refile('IMG.JPG')).toBe('2024/IMG.JPG');

    expect(await read('2024/IMG.xmp')).toBe('shared edit');
    expect(await read('2024/IMG.1.xmp')).toBeNull();
    expect(await read('2024/03-15/IMG.xmp')).toBeNull();
  });

  test("an identical photo at the destination isn't a dedupe while a stray sidecar sits beside it", async () => {
    await write('2024/03-15/IMG.HEIC', 'heic');
    await write('2024/IMG.HEIC', 'heic');
    await write('2024/IMG.xmp', 'a stray edit');

    expect(await refile('IMG.HEIC')).toBe('2024/IMG.1.HEIC');
    expect(await read('2024/IMG.xmp')).toBe('a stray edit');
  });

  test.skipIf(caseSensitive)(
    'a pair whose stems differ only in case still shares its sidecar when refiled in turn',
    async () => {
      await write('2024/03-15/img.HEIC', 'heic');
      await write('2024/03-15/IMG.JPG', 'jpeg');
      await write('2024/03-15/img.xmp', 'shared edit');

      expect(await refile('img.HEIC')).toBe('2024/img.HEIC');
      expect(await refile('IMG.JPG')).toBe('2024/IMG.JPG');
      expect(await read('2024/img.xmp')).toBe('shared edit');
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    'an unlistable destination folder is never taken as sidecar-free for a dedupe',
    async () => {
      await write('2024/03-15/IMG.HEIC', 'heic');
      await write('2024/IMG.HEIC', 'heic');
      await write('2024/IMG.xmp', 'an edit the listing cannot see');
      await fs.chmod(abs('2024'), 0o311);
      try {
        await expect(refile('IMG.HEIC')).rejects.toThrow();
      } finally {
        await fs.chmod(abs('2024'), 0o755);
      }

      expect(await read('2024/03-15/IMG.HEIC')).toBe('heic');
    },
  );
});
