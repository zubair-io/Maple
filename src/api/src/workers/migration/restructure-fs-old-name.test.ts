/**
 * Refile carries a photo's pre-#5021 `IMG.HEIC.xmp` (#5063) to its exact new
 * name, where the migration finds it. Real files in a temp library.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from '../../fs/mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { planAndPlace, finalize } from './restructure-fs.ts';
import { carryLateRefileSidecars } from './refile-sidecar.ts';
import * as ownership from '../../fs/sidecar-ownership.ts';
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'restructure-fs-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<string> {
  const abs = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}
async function exists(rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, ...rel.split('/')));
    return true;
  } catch {
    return false;
  }
}
async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
}

describe('planAndPlace — old-name backup edits (#5063)', () => {
  const maple = (label: string) =>
    `<x:xmpmeta xmlns:papp="http://ns.justmaple.app/photo/1.0/">${label}</x:xmpmeta>`;

  test("carries a photo's pre-#5021 IMG.HEIC.xmp, so the migration finds it at the new path", async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    await write('2024/Tokyo/03-15/IMG.HEIC.xmp', maple('backup edit'));

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
      liveVideoRelOld: null,
    });
    await finalize({
      libRoot: root,
      oldDirAbs: plan.oldDirAbs,
      mapleId: undefined,
      filename: 'IMG.HEIC',
      sourcesToDelete: plan.sourcesToDelete,
      carriedSidecars: plan.carriedSidecars,
    });

    expect(await fs.readFile(path.join(root, '2024/Tokyo/IMG.HEIC.xmp'), 'utf8')).toBe(
      maple('backup edit'),
    );
    expect(await exists('2024/Tokyo/03-15/IMG.HEIC.xmp')).toBe(false);
  });

  test('an old-name edit follows a photo renamed on collision', async () => {
    await write('2024/Tokyo/IMG.HEIC', 'someone else');
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    await write('2024/Tokyo/03-15/IMG.HEIC.xmp', maple('backup edit'));

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
      liveVideoRelOld: null,
    });

    expect(plan.newRelPath).toBe('2024/Tokyo/IMG.1.HEIC');
    expect(await fs.readFile(path.join(root, '2024/Tokyo/IMG.1.HEIC.xmp'), 'utf8')).toBe(
      maple('backup edit'),
    );
  });

  test("a stranded old-name edit keeps a refiled photo off its name, so it can't inherit that edit", async () => {
    await write('2024/Tokyo/IMG.HEIC.xmp', maple("a moved photo's edit"));
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
      liveVideoRelOld: null,
    });

    expect(plan.newRelPath).toBe('2024/Tokyo/IMG.1.HEIC');
    expect(await read('2024/Tokyo/IMG.HEIC.xmp')).toBe(maple("a moved photo's edit"));
  });

  // Root reads a mode-000 file anyway, so there is nothing to refuse.
  test.skipIf(process.getuid?.() === 0)(
    'an unreadable old-name edit stops the refile instead of being left behind',
    async () => {
      await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
      const legacy = await write('2024/Tokyo/03-15/IMG.HEIC.xmp', maple('backup edit'));
      await fs.chmod(legacy, 0o000);
      try {
        await expect(
          planAndPlace({
            libRoot: root,
            oldDir: '2024/Tokyo/03-15',
            filename: 'IMG.HEIC',
            newDir: '2024/Tokyo',
            renderedRelOld: null,
            liveVideoRelOld: null,
          }),
        ).rejects.toThrow(/EACCES|permission/i);
        expect(await exists('2024/Tokyo/IMG.HEIC')).toBe(false);
        expect(await exists('2024/Tokyo/03-15/IMG.HEIC')).toBe(true);
      } finally {
        await fs.chmod(legacy, 0o644);
      }
    },
  );

  test('carries an old-name edit stored in a different case', async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    await write('2024/Tokyo/03-15/img.heic.xmp', maple('backup edit'));

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
      liveVideoRelOld: null,
    });

    expect(await read('2024/Tokyo/IMG.HEIC.xmp')).toBe(maple('backup edit'));
    expect(plan.carriedSidecars.map((carried) => carried.source)).toContain(
      path.join(root, '2024/Tokyo/03-15/img.heic.xmp'),
    );
  });

  test('a stranded old-name edit in a different case keeps a refiled photo off its name', async () => {
    await write('2024/Tokyo/img.heic.xmp', maple("a moved photo's edit"));
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
      liveVideoRelOld: null,
    });

    expect(plan.newRelPath).toBe('2024/Tokyo/IMG.1.HEIC');
  });

  test('a carried old-name edit never lands on a name another file owns', async () => {
    await write('2024/Tokyo/IMG.HEIC.JPG', 'export');
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    await write('2024/Tokyo/03-15/IMG.HEIC.xmp', maple('backup edit'));

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
      liveVideoRelOld: null,
    });

    expect(plan.newRelPath).toBe('2024/Tokyo/IMG.1.HEIC');
    expect(await exists('2024/Tokyo/IMG.HEIC.xmp')).toBe(false);
  });

  test("a carried old-name edit never lands on another tool's file", async () => {
    const darktable = '<x:xmpmeta xmlns:darktable="http://darktable.sf.net/"/>';
    await write('2024/Tokyo/IMG.HEIC.xmp', darktable);
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    await write('2024/Tokyo/03-15/IMG.HEIC.xmp', maple('backup edit'));

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
      liveVideoRelOld: null,
    });

    expect(plan.newRelPath).toBe('2024/Tokyo/IMG.1.HEIC');
    expect(await read('2024/Tokyo/IMG.HEIC.xmp')).toBe(darktable);
    expect(await read('2024/Tokyo/IMG.1.HEIC.xmp')).toBe(maple('backup edit'));
  });

  test('an old-name slot taken after the photo landed fails the refile, never a suffixed name', async () => {
    const darktable = '<x:xmpmeta xmlns:darktable="http://darktable.sf.net/"/>';
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    await write('2024/Tokyo/03-15/IMG.HEIC.xmp', maple('backup edit'));
    const realLink = fs.link;
    const copy = spyOn(fs, 'link').mockImplementation(async (src, dst) => {
      await realLink(src, dst);
      if (String(dst).endsWith(`${path.sep}IMG.HEIC`)) {
        await write('2024/Tokyo/IMG.HEIC.xmp', darktable);
      }
    });
    try {
      const placing = planAndPlace({
        libRoot: root,
        oldDir: '2024/Tokyo/03-15',
        filename: 'IMG.HEIC',
        newDir: '2024/Tokyo',
        renderedRelOld: null,
        liveVideoRelOld: null,
      });
      await expect(placing).rejects.toThrow();
    } finally {
      copy.mockRestore();
    }

    expect(await read('2024/Tokyo/IMG.HEIC.xmp')).toBe(darktable);
    expect(await exists('2024/Tokyo/IMG.HEIC.1.xmp')).toBe(false);
    expect(await exists('2024/Tokyo/IMG.HEIC')).toBe(false);
    expect(await read('2024/Tokyo/03-15/IMG.HEIC.xmp')).toBe(maple('backup edit'));
  });

  const placeLate = async (late: () => Promise<unknown>) => {
    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
      liveVideoRelOld: null,
    });
    await late();
    const carried = await carryLateRefileSidecars(
      path.join(root, '2024/Tokyo/03-15/IMG.HEIC'),
      path.join(root, plan.newRelPath),
      plan.carriedSidecars,
    );
    await finalize({
      libRoot: root,
      oldDirAbs: plan.oldDirAbs,
      mapleId: undefined,
      filename: 'IMG.HEIC',
      sourcesToDelete: plan.sourcesToDelete,
      carriedSidecars: [...plan.carriedSidecars, ...carried],
    });
  };

  test('a late old-name edit follows the photo even when a same-stem sibling stays', async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    await write('2024/Tokyo/03-15/IMG.JPG', 'jpeg');

    await placeLate(() => write('2024/Tokyo/03-15/IMG.HEIC.xmp', maple('late backup edit')));

    expect(await read('2024/Tokyo/IMG.HEIC.xmp')).toBe(maple('late backup edit'));
    expect(await exists('2024/Tokyo/03-15/IMG.HEIC.xmp')).toBe(false);
  });

  test('a late old-name edit that cannot be carried keeps the photo at the old path', async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    const realPublish = ownership.publishSidecarSnapshot;
    const publish = spyOn(ownership, 'publishSidecarSnapshot').mockImplementation(
      async (source, dest, publications) =>
        String(source).endsWith('IMG.HEIC.xmp')
          ? Promise.reject(new Error('EIO'))
          : realPublish(source, dest, publications),
    );
    try {
      await placeLate(() => write('2024/Tokyo/03-15/IMG.HEIC.xmp', maple('late backup edit')));
    } finally {
      publish.mockRestore();
    }

    expect(await read('2024/Tokyo/IMG.HEIC')).toBe('pixels');
    expect(await read('2024/Tokyo/03-15/IMG.HEIC')).toBe('pixels');
    expect(await read('2024/Tokyo/03-15/IMG.HEIC.xmp')).toBe(maple('late backup edit'));
  });

  test('a late old-name edit never lands on a name another file at the destination owns', async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    await write('2024/Tokyo/IMG.HEIC.JPG', 'export');

    await placeLate(() => write('2024/Tokyo/03-15/IMG.HEIC.xmp', maple('late backup edit')));

    expect(await exists('2024/Tokyo/IMG.HEIC.xmp')).toBe(false);
    expect(await read('2024/Tokyo/IMG (conflict from refile).xmp')).toBe(maple('late backup edit'));
  });
});
