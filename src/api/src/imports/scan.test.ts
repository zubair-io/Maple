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
