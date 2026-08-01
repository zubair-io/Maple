import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { planAndPlace, finalize, revertCreated, SourceMissingError } from './restructure-fs.ts';

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

describe('planAndPlace — crash-safe ordering', () => {
  test('copies file + sidecar to new dir, leaves sources until finalize', async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    await write('2024/Tokyo/03-15/IMG.xmp', 'edits');

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
    });

    expect(plan.outcome).toBe('copied');
    expect(plan.newRelPath).toBe('2024/Tokyo/IMG.HEIC');
    // New copies exist AND old sources still exist — the crash-safe invariant
    // between verify and delete.
    expect(await exists('2024/Tokyo/IMG.HEIC')).toBe(true);
    expect(await exists('2024/Tokyo/IMG.xmp')).toBe(true);
    expect(await exists('2024/Tokyo/03-15/IMG.HEIC')).toBe(true);
    expect(await read('2024/Tokyo/IMG.HEIC')).toBe('pixels');
  });

  test('copies a video + its full-name .mov.xmp sidecar (#1678)', async () => {
    await write('2024/Tokyo/03-15/CLIP.mov', 'frames');
    // M5 full-name sidecar convention: `clip.mov.xmp`, NOT stem-swapped `clip.xmp`.
    await write('2024/Tokyo/03-15/CLIP.mov.xmp', 'video-edits');

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'CLIP.mov',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
    });

    expect(plan.outcome).toBe('copied');
    expect(plan.newRelPath).toBe('2024/Tokyo/CLIP.mov');
    expect(await exists('2024/Tokyo/CLIP.mov')).toBe(true);
    expect(await exists('2024/Tokyo/CLIP.mov.xmp')).toBe(true);
    expect(await read('2024/Tokyo/CLIP.mov')).toBe('frames');
    expect(await read('2024/Tokyo/CLIP.mov.xmp')).toBe('video-edits');
    // Sources still present until finalize (crash-safe invariant).
    expect(await exists('2024/Tokyo/03-15/CLIP.mov')).toBe(true);
    expect(await exists('2024/Tokyo/03-15/CLIP.mov.xmp')).toBe(true);
    expect(plan.sourcesToDelete).toContain(path.join(root, '2024/Tokyo/03-15/CLIP.mov'));
    expect(plan.sourcesToDelete).toContain(path.join(root, '2024/Tokyo/03-15/CLIP.mov.xmp'));
  });

  test('a video sidecar does not pull in a same-stem photo sidecar (Live Photo pairing safety, #1678)', async () => {
    // Live Photo pairing: same stem, independent still + motion clip, independent sidecars.
    await write('2024/Tokyo/03-15/IMG_1.HEIC', 'still-pixels');
    await write('2024/Tokyo/03-15/IMG_1.xmp', 'still-edits');
    await write('2024/Tokyo/03-15/IMG_1.MOV', 'clip-frames');
    await write('2024/Tokyo/03-15/IMG_1.MOV.xmp', 'clip-edits');

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG_1.MOV',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
    });

    expect(await exists('2024/Tokyo/IMG_1.MOV')).toBe(true);
    expect(await exists('2024/Tokyo/IMG_1.MOV.xmp')).toBe(true);
    // The still photo's own sidecar must NOT be swept up as a "companion".
    expect(await exists('2024/Tokyo/IMG_1.xmp')).toBe(false);
    expect(plan.sourcesToDelete).not.toContain(path.join(root, '2024/Tokyo/03-15/IMG_1.xmp'));
    // Still photo untouched at the old dir.
    expect(await exists('2024/Tokyo/03-15/IMG_1.HEIC')).toBe(true);
    expect(await exists('2024/Tokyo/03-15/IMG_1.xmp')).toBe(true);
  });

  test('rendered companion travels and reports its new rel path', async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    await write('2024/Tokyo/03-15/IMG.rendered.JPEG', 'rendered');

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: '2024/Tokyo/03-15/IMG.rendered.JPEG',
    });
    expect(plan.newRenderedRel).toBe('2024/Tokyo/IMG.rendered.JPEG');
    expect(await exists('2024/Tokyo/IMG.rendered.JPEG')).toBe(true);
  });

  test('reports createdPaths; revertCreated rolls them back leaving sources intact', async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    await write('2024/Tokyo/03-15/IMG.xmp', 'edits');

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
    });
    // The new copies are tracked for rollback (primary + sidecar).
    expect(plan.createdPaths).toContain(path.join(root, '2024/Tokyo/IMG.HEIC'));
    expect(plan.createdPaths).toContain(path.join(root, '2024/Tokyo/IMG.xmp'));

    // Simulate a failed DB repoint: roll back. Originals must survive.
    await revertCreated(plan.createdPaths);
    expect(await exists('2024/Tokyo/IMG.HEIC')).toBe(false);
    expect(await exists('2024/Tokyo/IMG.xmp')).toBe(false);
    expect(await read('2024/Tokyo/03-15/IMG.HEIC')).toBe('pixels'); // source intact
    expect(await read('2024/Tokyo/03-15/IMG.xmp')).toBe('edits');
  });

  test('throws SourceMissingError when the original is gone', async () => {
    await expect(
      planAndPlace({
        libRoot: root,
        oldDir: '2024/Tokyo/03-15',
        filename: 'GONE.HEIC',
        newDir: '2024/Tokyo',
        renderedRelOld: null,
      }),
    ).rejects.toBeInstanceOf(SourceMissingError);
  });
});

describe('planAndPlace — collisions', () => {
  test('byte-identical occupant + no companions → dedupe (no copy)', async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'same');
    await write('2024/Tokyo/IMG.HEIC', 'same'); // already-migrated twin, identical

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
    });
    expect(plan.outcome).toBe('deduped');
    expect(plan.newRelPath).toBe('2024/Tokyo/IMG.HEIC');
    expect(plan.sourcesToDelete).toEqual([path.join(root, '2024/Tokyo/03-15/IMG.HEIC')]);
  });

  test('byte-identical occupant BUT source has a sidecar → rename, never dedupe', async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'same');
    await write('2024/Tokyo/03-15/IMG.xmp', 'distinct edits'); // companion → must not drop
    await write('2024/Tokyo/IMG.HEIC', 'same');

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
    });
    expect(plan.outcome).toBe('renamed');
    expect(plan.newRelPath).toBe('2024/Tokyo/IMG.1.HEIC');
    // The occupant is untouched; the sidecar followed the new base.
    expect(await read('2024/Tokyo/IMG.HEIC')).toBe('same');
    expect(await exists('2024/Tokyo/IMG.1.xmp')).toBe(true);
  });

  test('different-content collision → numeric suffix, occupant untouched', async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'newcomer');
    await write('2024/Tokyo/IMG.HEIC', 'occupant');

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
    });
    expect(plan.outcome).toBe('renamed');
    expect(plan.newRelPath).toBe('2024/Tokyo/IMG.1.HEIC');
    expect(await read('2024/Tokyo/IMG.HEIC')).toBe('occupant');
    expect(await read('2024/Tokyo/IMG.1.HEIC')).toBe('newcomer');
  });
});

describe('finalize — delete sources, drop cache, reclaim folder', () => {
  test('deletes sources, drops maple_id cache (both thumb extensions), removes empty old dir', async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    // Current (AVIF) and a legacy pre-v3 (JPEG) thumb can both be sitting at
    // the old path depending on when it was last rendered — dropOldCache
    // must sweep both.
    await write('2024/Tokyo/03-15/.maple/thumbs/abc123.avif', 'thumb-avif');
    await write('2024/Tokyo/03-15/.maple/thumbs/abc123.jpg', 'thumb-jpg');
    await write('2024/Tokyo/03-15/.maple/previews/abc123_full.jpg', 'preview');

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
    });
    await finalize({
      libRoot: root,
      oldDirAbs: plan.oldDirAbs,
      mapleId: 'abc123',
      filename: 'IMG.HEIC',
      sourcesToDelete: plan.sourcesToDelete,
    });

    expect(await exists('2024/Tokyo/03-15/IMG.HEIC')).toBe(false);
    expect(await exists('2024/Tokyo/03-15/.maple/thumbs/abc123.avif')).toBe(false);
    expect(await exists('2024/Tokyo/03-15/.maple/thumbs/abc123.jpg')).toBe(false);
    expect(await exists('2024/Tokyo/03-15/.maple/previews/abc123_full.jpg')).toBe(false);
    expect(await exists('2024/Tokyo/03-15')).toBe(false); // reclaimed
    expect(await exists('2024/Tokyo/IMG.HEIC')).toBe(true); // survivor
  });

  test('leaves the old dir when another (not-yet-migrated) photo remains', async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    await write('2024/Tokyo/03-15/OTHER.HEIC', 'other'); // still to migrate

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
    });
    await finalize({
      libRoot: root,
      oldDirAbs: plan.oldDirAbs,
      mapleId: undefined,
      filename: 'IMG.HEIC',
      sourcesToDelete: plan.sourcesToDelete,
    });

    expect(await exists('2024/Tokyo/03-15')).toBe(true);
    expect(await exists('2024/Tokyo/03-15/OTHER.HEIC')).toBe(true);
  });

  test('does not drop another photo cache sharing the day-folder .maple', async () => {
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    await write('2024/Tokyo/03-15/.maple/thumbs/abc123.jpg', 'mine');
    await write('2024/Tokyo/03-15/.maple/thumbs/other999.jpg', 'theirs');

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
    });
    await finalize({
      libRoot: root,
      oldDirAbs: plan.oldDirAbs,
      mapleId: 'abc123',
      filename: 'IMG.HEIC',
      sourcesToDelete: plan.sourcesToDelete,
    });

    // Mine dropped, theirs preserved; dir stays because a foreign cache remains.
    expect(await exists('2024/Tokyo/03-15/.maple/thumbs/abc123.jpg')).toBe(false);
    expect(await exists('2024/Tokyo/03-15/.maple/thumbs/other999.jpg')).toBe(true);
    expect(await exists('2024/Tokyo/03-15')).toBe(true);
  });

  test('never removes a dir at/above the library root', async () => {
    // oldDirAbs == libRoot must be a no-op even if "empty".
    await finalize({
      libRoot: root,
      oldDirAbs: root,
      mapleId: undefined,
      filename: 'x.HEIC',
      sourcesToDelete: [],
    });
    expect(await exists('')).toBe(true); // root still there
  });

  test('drops legacy basename-keyed cache files too (folder reclamation)', async () => {
    const { sha256Prefix16 } = await import('../../fs/xmp.ts');
    await write('2024/Tokyo/03-15/IMG.HEIC', 'pixels');
    // Legacy basename-keyed thumb + preview (pre content-addressing).
    await write(`2024/Tokyo/03-15/.maple/thumbs/${sha256Prefix16('IMG.HEIC')}.jpg`, 'legacy-thumb');
    await write('2024/Tokyo/03-15/.maple/previews/IMG_1280.jpg', 'legacy-preview');

    const plan = await planAndPlace({
      libRoot: root,
      oldDir: '2024/Tokyo/03-15',
      filename: 'IMG.HEIC',
      newDir: '2024/Tokyo',
      renderedRelOld: null,
    });
    await finalize({
      libRoot: root,
      oldDirAbs: plan.oldDirAbs,
      mapleId: undefined, // legacy row never got a maple_id-keyed cache
      filename: 'IMG.HEIC',
      sourcesToDelete: plan.sourcesToDelete,
    });

    // Legacy cache cleared and the day-folder reclaimed.
    expect(await exists(`2024/Tokyo/03-15/.maple/thumbs/${sha256Prefix16('IMG.HEIC')}.jpg`)).toBe(
      false,
    );
    expect(await exists('2024/Tokyo/03-15/.maple/previews/IMG_1280.jpg')).toBe(false);
    expect(await exists('2024/Tokyo/03-15')).toBe(false);
  });
});
