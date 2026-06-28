/**
 * scan.ts integration tests — real temp-dir trees, no Mongo.
 *
 * Covers: recursive walk, file classification, sidecar pairing, mtime
 * bucketing, label overrides in buildImportFiles, and sidecar-before-image
 * ordering.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanFolder, buildImportFiles } from './scan.ts';

let root: string;

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
    // Untouched bucket keeps the default MM label.
    const nef = files.find((f) => f.dest.endsWith('OLD_0002.nef'))!;
    expect(nef.dest).toBe('2007/11/OLD_0002.nef');
  });

  test('places a sidecar in the same bucket/label as its image, before it', async () => {
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

  async function putHidden(rel: string): Promise<void> {
    const abs = path.join(hiddenRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, `content-of-${rel}`);
    const when = new Date('2024-05-01T12:00:00Z');
    await fs.utimes(abs, when, when);
  }

  beforeAll(async () => {
    hiddenRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-hidden-'));
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
    // The sidecar still pairs to its image (same bucket/label, before it).
    const xmp = files.find((f) => f.dest.endsWith('IMG_9001.xmp'))!;
    expect(xmp.kind).toBe('sidecar');
    expect(xmp.dest).toBe('2024/05/IMG_9001.xmp');
  });
});

// M5 — #1635: sidecars pair to movies as well as images.
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
    // A movie with a sidecar (M5: sidecar should pair, not orphan).
    await putV('clip.mov', '2024-06-15T10:00:00Z');
    await putV('clip.xmp', '2024-06-15T10:05:00Z');
    // An image with a sidecar — regression: must still pair correctly.
    await putV('photo.dng', '2024-06-15T11:00:00Z');
    await putV('photo.xmp', '2024-06-15T11:05:00Z');
  });

  afterAll(async () => {
    await fs.rm(videoRoot, { recursive: true, force: true });
  });

  test('scanFolder: clip.xmp pairs to clip.mov, counted as sidecar not orphan', async () => {
    const res = await scanFolder(videoRoot);
    // Both the movie's sidecar and the image's sidecar are counted.
    expect(res.totals.sidecars).toBe(2);
    expect(res.totals.movies).toBe(1);
    expect(res.totals.images).toBe(1);
  });

  test('buildImportFiles: clip.xmp is emitted as sidecar kind before clip.mov', async () => {
    const files = await buildImportFiles(videoRoot, {});
    const xmp = files.find((f) => f.dest.endsWith('clip.xmp'))!;
    const mov = files.find((f) => f.dest.endsWith('clip.mov'))!;
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

  test('collision: image wins when same-stem image and movie coexist', async () => {
    // Create a fresh dir with clip.jpg, clip.mov, clip.xmp — image should win.
    const collRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-coll-'));
    try {
      const put2 = async (rel: string): Promise<void> => {
        const abs = path.join(collRoot, rel);
        await fs.writeFile(abs, `content-of-${rel}`);
        const when = new Date('2024-07-01T00:00:00Z');
        await fs.utimes(abs, when, when);
      };
      await put2('clip.jpg');
      await put2('clip.mov');
      await put2('clip.xmp');
      const files = await buildImportFiles(collRoot, {});
      const xmp = files.find((f) => f.dest.endsWith('clip.xmp'))!;
      const jpg = files.find((f) => f.dest.endsWith('clip.jpg'))!;
      // The sidecar attaches to the image (not lost as orphan).
      expect(xmp.kind).toBe('sidecar');
      expect(files.indexOf(xmp)).toBeLessThan(files.indexOf(jpg));
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

  async function putFile(rel: string, mtimeUtc: string): Promise<void> {
    const abs = path.join(mixedRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, `content-of-${rel}`);
    const when = new Date(mtimeUtc);
    await fs.utimes(abs, when, when);
  }

  beforeAll(async () => {
    mixedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-unsafe-'));
    // March 2024 image + sidecar — we'll give 2024/03 an unsafe label.
    await putFile('BAD_0001.dng', '2024-03-09T12:00:00Z');
    await putFile('BAD_0001.xmp', '2024-03-09T12:05:00Z');
    // November 2007 image — its 2007/11 bucket gets a safe default label.
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
    expect(good.dest).toBe('2007/11/GOOD_0002.nef');
  });
});
