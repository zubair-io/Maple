/**
 * scan.ts integration tests — real temp-dir trees, no Mongo.
 *
 * Covers: recursive walk (including symlinks), file classification, sidecar
 * pairing, mtime bucketing, destination precedence in buildImportFiles
 * (label override → nearby-asset match → shot-folder fallback → misc
 * default), and sidecar-before-image ordering.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanFolder, buildImportFiles } from './scan.ts';

let root: string;
let rootFolderName: string;

/** Write a file and stamp its mtime to a fixed UTC instant. */
async function put(rel: string, mtimeUtc: string): Promise<string> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `content-of-${rel}`);
  const when = new Date(mtimeUtc);
  await fs.utimes(abs, when, when);
  return abs;
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-scan-'));
  rootFolderName = path.basename(root);
  // March 2024 image + its sidecar (nested).
  await put('a/IMG_0001.dng', '2024-03-09T12:00:00Z');
  await put('a/IMG_0001.xmp', '2024-03-09T12:05:00Z');
  // November 2007 image, no sidecar.
  await put('b/c/OLD_0002.nef', '2007-11-25T08:00:00Z');
  // A movie in March 2024.
  await put('a/clip.mov', '2024-03-20T00:00:00Z');
  // A non-media file — must be ignored.
  await put('a/notes.txt', '2024-03-09T12:00:00Z');
  // An orphan sidecar (no matching image) — must be ignored.
  await put('a/ORPHAN.xmp', '2024-03-09T12:00:00Z');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('scanFolder', () => {
  test('groups images and movies into UTC mtime buckets', async () => {
    const res = await scanFolder(root);
    const keys = res.buckets.map((b) => b.key);
    expect(keys).toEqual(['2007/11', '2024/03']);

    const mar = res.buckets.find((b) => b.key === '2024/03')!;
    expect(mar.imageCount).toBe(1);
    expect(mar.movieCount).toBe(1);
    expect(mar.sidecarCount).toBe(1); // IMG_0001.xmp
    expect(mar.fileCount).toBe(3); // image + sidecar + movie

    const nov = res.buckets.find((b) => b.key === '2007/11')!;
    expect(nov.imageCount).toBe(1);
    expect(nov.sidecarCount).toBe(0);
  });

  test('totals ignore non-media and orphan sidecars', async () => {
    const res = await scanFolder(root);
    expect(res.totals.images).toBe(2);
    expect(res.totals.movies).toBe(1);
    expect(res.totals.sidecars).toBe(1); // orphan + notes excluded
  });

  test('default bucket label is the two-digit month', async () => {
    const res = await scanFolder(root);
    expect(res.buckets.find((b) => b.key === '2024/03')!.mm).toBe('03');
  });
});

describe('buildImportFiles', () => {
  test('applies label overrides keyed on bucket key', async () => {
    const files = await buildImportFiles(root, { '2024/03': 'Spring Trip' });
    const dngs = files.filter((f) => f.dest.endsWith('IMG_0001.dng'));
    expect(dngs).toHaveLength(1);
    expect(dngs[0].dest).toBe('2024/Spring Trip/IMG_0001.dng');
    // Untouched bucket falls back to the misc/<source folder> default.
    const nef = files.find((f) => f.dest.endsWith('OLD_0002.nef'))!;
    expect(nef.dest).toBe(`2007/misc/${rootFolderName}/OLD_0002.nef`);
  });

  test('an unset (or blank) label uses the misc/<source folder> default', async () => {
    const files = await buildImportFiles(root, { '2024/03': '  ' });
    const dng = files.find((f) => f.dest.endsWith('IMG_0001.dng'))!;
    expect(dng.dest).toBe(`2024/misc/${rootFolderName}/IMG_0001.dng`);
  });

  test('places a sidecar in the same folder as its image, before it', async () => {
    const files = await buildImportFiles(root, { '2024/03': 'Spring Trip' });
    const xmpIdx = files.findIndex((f) => f.dest.endsWith('IMG_0001.xmp'));
    const dngIdx = files.findIndex((f) => f.dest.endsWith('IMG_0001.dng'));
    expect(xmpIdx).toBeGreaterThanOrEqual(0);
    expect(xmpIdx).toBeLessThan(dngIdx);
    expect(files[xmpIdx].dest).toBe('2024/Spring Trip/IMG_0001.xmp');
    expect(files[xmpIdx].kind).toBe('sidecar');
  });

  test('classifies movies as movie kind', async () => {
    const files = await buildImportFiles(root, {});
    const mov = files.find((f) => f.dest.endsWith('clip.mov'))!;
    expect(mov.kind).toBe('movie');
  });

  test('a nearby-asset match wins over the misc default, even with no label override', async () => {
    const files = await buildImportFiles(
      root,
      {},
      { findNearbyFolder: async () => '2007/Reunion' },
    );
    const nef = files.find((f) => f.dest.endsWith('OLD_0002.nef'))!;
    expect(nef.dest).toBe('2007/Reunion/OLD_0002.nef');
  });

  test('an explicit label override still wins over a nearby-asset match', async () => {
    const files = await buildImportFiles(
      root,
      { '2007/11': 'Explicit' },
      { findNearbyFolder: async () => '2007/Reunion' },
    );
    const nef = files.find((f) => f.dest.endsWith('OLD_0002.nef'))!;
    expect(nef.dest).toBe('2007/Explicit/OLD_0002.nef');
  });

  test('findNearbyFolder is queried with the file mtime', async () => {
    const seen: number[] = [];
    await buildImportFiles(
      root,
      {},
      {
        findNearbyFolder: async (mtimeMs) => {
          seen.push(mtimeMs);
          return null;
        },
      },
    );
    // Every primary (image + movie; the sidecar shares its image's lookup) was queried.
    expect(seen).toContain(new Date('2024-03-09T12:00:00Z').getTime());
    expect(seen).toContain(new Date('2007-11-25T08:00:00Z').getTime());
  });
});

// Symlinks: a source folder is often a tree of symlinks into a NAS/removable
// mount. walk() must follow both symlinked directories and symlinked files,
// while a cyclic symlink can't cause an infinite loop.
describe('walk() follows symlinks', () => {
  let symRoot: string;
  let realDir: string;

  beforeAll(async () => {
    symRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-symlink-'));
    realDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-symlink-target-'));

    // A real file living outside symRoot, symlinked in as a plain file.
    const realFile = path.join(realDir, 'REAL_0001.dng');
    await fs.writeFile(realFile, 'content');
    const when = new Date('2024-08-01T00:00:00Z');
    await fs.utimes(realFile, when, when);
    await fs.symlink(realFile, path.join(symRoot, 'LINKED_0001.dng'));

    // A real directory (with a file inside), symlinked in as a subdirectory.
    const realSubdir = path.join(realDir, 'sub');
    await fs.mkdir(realSubdir, { recursive: true });
    const nestedFile = path.join(realSubdir, 'NESTED_0002.nef');
    await fs.writeFile(nestedFile, 'content');
    await fs.utimes(nestedFile, when, when);
    await fs.symlink(realSubdir, path.join(symRoot, 'linked-dir'), 'dir');

    // A cyclic symlink: symRoot/loop -> symRoot (must not recurse forever).
    await fs.symlink(symRoot, path.join(symRoot, 'loop'), 'dir');
  });

  afterAll(async () => {
    await fs.rm(symRoot, { recursive: true, force: true });
    await fs.rm(realDir, { recursive: true, force: true });
  });

  test('scanFolder counts files reached through symlinked files and directories', async () => {
    const res = await scanFolder(symRoot);
    expect(res.totals.images).toBe(2); // LINKED_0001.dng + NESTED_0002.nef
  });

  test('buildImportFiles resolves a destination for symlinked files without hanging', async () => {
    const symFolderName = path.basename(symRoot);
    const files = await buildImportFiles(symRoot, {});
    const names = files.map((f) => path.posix.basename(f.dest));
    expect(names).toContain('LINKED_0001.dng');
    expect(names).toContain('NESTED_0002.nef');
    const linked = files.find((f) => f.dest.endsWith('LINKED_0001.dng'))!;
    expect(linked.dest).toBe(`2024/misc/${symFolderName}/LINKED_0001.dng`);
  });
});

// New default: an anonymous camera dump-folder name (Shot0123 / 0123 / 012)
// keeps its parent directory's name for context instead of a flat `misc`.
describe('buildImportFiles: shot-folder fallback', () => {
  let dcimRoot: string;
  let shotDir: string;

  beforeAll(async () => {
    dcimRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-dcim-'));
    shotDir = path.join(dcimRoot, '0123');
    await fs.mkdir(shotDir, { recursive: true });
    const abs = path.join(shotDir, 'IMG_0001.dng');
    await fs.writeFile(abs, 'content');
    const when = new Date('2024-09-01T00:00:00Z');
    await fs.utimes(abs, when, when);
  });

  afterAll(async () => {
    await fs.rm(dcimRoot, { recursive: true, force: true });
  });

  test('uses <year>/<parentFolderName>/<folderName> when the source folder is a bare number', async () => {
    const files = await buildImportFiles(shotDir, {});
    const img = files.find((f) => f.dest.endsWith('IMG_0001.dng'))!;
    expect(img.dest).toBe(`2024/${path.basename(dcimRoot)}/0123/IMG_0001.dng`);
  });

  test('a nearby-asset match still wins over the shot-folder fallback', async () => {
    const files = await buildImportFiles(
      shotDir,
      {},
      { findNearbyFolder: async () => '2024/Reunion' },
    );
    const img = files.find((f) => f.dest.endsWith('IMG_0001.dng'))!;
    expect(img.dest).toBe('2024/Reunion/IMG_0001.dng');
  });
});

// Regression for #793: a folder containing a leading-dot hidden/temp file
// (Lightroom `.LrTmp-*`, macOS AppleDouble `._*`, `.DS_Store`) used to fail the
// WHOLE import — the temp file's extension passed classify(), then destRelPath
// → isSafeFilename rejected the leading dot and THREW. The walk() now skips any
// leading-dot entry, so hidden files are silently dropped and real siblings
// still import without throwing. Uses its own temp dir so the totals assertions
// in the suite above (which expect exactly 1 movie) are unaffected.
describe('walk() skips hidden/temp files (#793)', () => {
  let hiddenRoot: string;
  let hiddenFolderName: string;

  async function putHidden(rel: string): Promise<void> {
    const abs = path.join(hiddenRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, `content-of-${rel}`);
    const when = new Date('2024-05-01T12:00:00Z');
    await fs.utimes(abs, when, when);
  }

  beforeAll(async () => {
    hiddenRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-hidden-'));
    hiddenFolderName = path.basename(hiddenRoot);
    // The literal reported Lightroom temp file + other hidden entries.
    await putHidden('.LrTmp-0a5769699416531db35ca57a8969401a.mp4');
    await putHidden('._IMG_9001.jpg'); // macOS AppleDouble
    await putHidden('.DS_Store');
    // Real siblings that MUST still import.
    await putHidden('IMG_9001.jpg');
    await putHidden('IMG_9001.xmp'); // sidecar for the real image
    await putHidden('real-clip.mp4');
  });

  afterAll(async () => {
    await fs.rm(hiddenRoot, { recursive: true, force: true });
  });

  test('scanFolder excludes hidden files but counts the real siblings', async () => {
    const res = await scanFolder(hiddenRoot);
    // 1 real image + 1 real movie + 1 paired sidecar; nothing hidden.
    expect(res.totals.images).toBe(1);
    expect(res.totals.movies).toBe(1);
    expect(res.totals.sidecars).toBe(1);
  });

  test('buildImportFiles does not throw and skips the hidden files', async () => {
    const files = await buildImportFiles(hiddenRoot, {});
    const names = files.map((f) => path.posix.basename(f.dest));
    // The reported .LrTmp temp file and other dotfiles never reach destRelPath.
    expect(names).not.toContain('.LrTmp-0a5769699416531db35ca57a8969401a.mp4');
    expect(names).not.toContain('._IMG_9001.jpg');
    expect(names).not.toContain('.DS_Store');
    // Real siblings — image, its sidecar, and the real movie — all present.
    expect(names).toContain('IMG_9001.jpg');
    expect(names).toContain('IMG_9001.xmp');
    expect(names).toContain('real-clip.mp4');
    // The sidecar still pairs to its image (same folder, before it).
    const xmp = files.find((f) => f.dest.endsWith('IMG_9001.xmp'))!;
    expect(xmp.kind).toBe('sidecar');
    expect(xmp.dest).toBe(`2024/misc/${hiddenFolderName}/IMG_9001.xmp`);
  });
});

// M5 — #1635: videos carry FULL-NAME metadata sidecars (`clip.mov.xmp`),
// images keep the stem-swap convention (`photo.xmp`). They must pair to their
// own primary and never to a same-stem sibling.
describe('video sidecar pairing (M5, #1635)', () => {
  let videoRoot: string;

  async function putV(rel: string, mtimeUtc: string): Promise<void> {
    const abs = path.join(videoRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, `content-of-${rel}`);
    const when = new Date(mtimeUtc);
    await fs.utimes(abs, when, when);
  }

  beforeAll(async () => {
    videoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-video-'));
    // A movie with a full-name sidecar (M5: pairs to the movie, not orphan).
    await putV('clip.mov', '2024-06-15T10:00:00Z');
    await putV('clip.mov.xmp', '2024-06-15T10:05:00Z');
    // An image with a sidecar — regression: must still pair correctly.
    await putV('photo.dng', '2024-06-15T11:00:00Z');
    await putV('photo.xmp', '2024-06-15T11:05:00Z');
  });

  afterAll(async () => {
    await fs.rm(videoRoot, { recursive: true, force: true });
  });

  test('scanFolder: clip.mov.xmp pairs to clip.mov, counted as sidecar not orphan', async () => {
    const res = await scanFolder(videoRoot);
    // Both the movie's sidecar and the image's sidecar are counted.
    expect(res.totals.sidecars).toBe(2);
    expect(res.totals.movies).toBe(1);
    expect(res.totals.images).toBe(1);
  });

  test('buildImportFiles: clip.mov.xmp is emitted as sidecar kind before clip.mov', async () => {
    const files = await buildImportFiles(videoRoot, {});
    const xmp = files.find((f) => f.dest.endsWith('clip.mov.xmp'))!;
    const mov = files.find((f) => f.dest.endsWith('clip.mov') && !f.dest.endsWith('.xmp'))!;
    expect(xmp).toBeDefined();
    expect(xmp.kind).toBe('sidecar');
    // Sidecar emitted before its primary.
    const xmpIdx = files.indexOf(xmp);
    const movIdx = files.indexOf(mov);
    expect(xmpIdx).toBeGreaterThanOrEqual(0);
    expect(xmpIdx).toBeLessThan(movIdx);
  });

  test('image sidecar still pairs correctly alongside a video sidecar', async () => {
    const files = await buildImportFiles(videoRoot, {});
    const photoXmp = files.find((f) => f.dest.endsWith('photo.xmp'))!;
    const photoDng = files.find((f) => f.dest.endsWith('photo.dng'))!;
    expect(photoXmp.kind).toBe('sidecar');
    expect(files.indexOf(photoXmp)).toBeLessThan(files.indexOf(photoDng));
  });

  test('Live Photo: same-stem image + movie each get their own separate sidecar', async () => {
    // Apple Live Photo on disk: IMG_1234.jpg + IMG_1234.mov, two independent
    // assets. With full-name video sidecars there is no collision — the photo
    // owns clip.xmp (stem-swap) and the movie owns clip.mov.xmp (full-name).
    const collRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-coll-'));
    try {
      const put2 = async (rel: string): Promise<void> => {
        const abs = path.join(collRoot, rel);
        await fs.writeFile(abs, `content-of-${rel}`);
        const when = new Date('2024-07-01T00:00:00Z');
        await fs.utimes(abs, when, when);
      };
      await put2('clip.jpg');
      await put2('clip.xmp'); // the photo's sidecar
      await put2('clip.mov');
      await put2('clip.mov.xmp'); // the movie's sidecar
      const res = await scanFolder(collRoot);
      // Both sidecars pair — neither orphaned, neither stolen.
      expect(res.totals.sidecars).toBe(2);
      expect(res.totals.images).toBe(1);
      expect(res.totals.movies).toBe(1);

      const files = await buildImportFiles(collRoot, {});
      const photoXmp = files.find((f) => f.dest.endsWith('clip.xmp'))!;
      const jpg = files.find((f) => f.dest.endsWith('clip.jpg'))!;
      const movXmp = files.find((f) => f.dest.endsWith('clip.mov.xmp'))!;
      const mov = files.find((f) => f.dest.endsWith('clip.mov') && !f.dest.endsWith('.xmp'))!;
      // Photo's sidecar attaches to the image, before it.
      expect(photoXmp.kind).toBe('sidecar');
      expect(files.indexOf(photoXmp)).toBeLessThan(files.indexOf(jpg));
      // Movie's sidecar attaches to the movie, before it.
      expect(movXmp.kind).toBe('sidecar');
      expect(files.indexOf(movXmp)).toBeLessThan(files.indexOf(mov));
    } finally {
      await fs.rm(collRoot, { recursive: true, force: true });
    }
  });
});

// #795: buildImportFiles must skip-and-continue when destRelPath throws on an
// unsafe segment, instead of aborting the whole batch. An unsafe BUCKET LABEL
// is the easiest reliable trigger (a too-long filename can't even be written to
// disk on most filesystems): every file in that bucket is failed, while a file
// in a DIFFERENT, validly-labelled bucket still imports.
describe('buildImportFiles skips files with an unsafe destination (#795)', () => {
  let mixedRoot: string;
  let mixedFolderName: string;

  async function putFile(rel: string, mtimeUtc: string): Promise<void> {
    const abs = path.join(mixedRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, `content-of-${rel}`);
    const when = new Date(mtimeUtc);
    await fs.utimes(abs, when, when);
  }

  beforeAll(async () => {
    mixedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-unsafe-'));
    mixedFolderName = path.basename(mixedRoot);
    // March 2024 image + sidecar — we'll give 2024/03 an unsafe label.
    await putFile('BAD_0001.dng', '2024-03-09T12:00:00Z');
    await putFile('BAD_0001.xmp', '2024-03-09T12:05:00Z');
    // November 2007 image — its 2007/11 bucket keeps the safe misc default.
    await putFile('GOOD_0002.nef', '2007-11-25T08:00:00Z');
  });

  afterAll(async () => {
    await fs.rm(mixedRoot, { recursive: true, force: true });
  });

  test('records the unsafe-bucket files as failed and keeps the good ones pending', async () => {
    // A label with a path separator is rejected by isSafeLabel → destRelPath
    // throws for every file bucketed under 2024/03.
    const files = await buildImportFiles(mixedRoot, { '2024/03': 'a/b' });

    const bad = files.find((f) => f.dest.endsWith('BAD_0001.dng'))!;
    expect(bad.state).toBe('failed');
    expect(bad.error).toBeTruthy();
    expect(bad.error).toContain('unsafe');

    // The sidecar under the failed image is failed too (not silently dropped).
    const badXmp = files.find((f) => f.dest.endsWith('BAD_0001.xmp'))!;
    expect(badXmp.state).toBe('failed');
    expect(badXmp.kind).toBe('sidecar');

    // The validly-labelled November image still imports normally.
    const good = files.find((f) => f.dest.endsWith('GOOD_0002.nef'))!;
    expect(good.state).toBe('pending');
    expect(good.error).toBeNull();
    expect(good.dest).toBe(`2007/misc/${mixedFolderName}/GOOD_0002.nef`);
  });
});
