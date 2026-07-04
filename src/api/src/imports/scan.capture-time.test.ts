/**
 * scan.ts integration tests for EXIF-capture-time bucketing/placement and the
 * scan-preview destination fields (defaultDest / nearbyMatchCount /
 * nearbyMatchFolders). Split out of scan.test.ts to keep that file under the
 * repo's file-size budget (see CONTRIBUTING.md).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanFolder, buildImportFiles } from './scan.ts';

let previousMapleRoots: string | undefined;

// walk() re-checks every symlink target against MAPLE_ROOTS (see scan.ts).
// This suite's temp dirs all live under os.tmpdir(), so jail to that for the
// file's duration — bun runs every test file in one process, so without
// this, whatever another file left in `process.env.MAPLE_ROOTS` (many test
// files set it to their OWN narrow temp dir and never restore it) would leak
// in here and reject every path in this file. Restored in the matching
// afterAll so it doesn't leak OUT to files that run after this one.
beforeAll(async () => {
  previousMapleRoots = process.env.MAPLE_ROOTS;
  process.env.MAPLE_ROOTS = await fs.realpath(os.tmpdir());
});

afterAll(() => {
  if (previousMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = previousMapleRoots;
});

// Bucketing/nearby-match now key off CAPTURE time (EXIF DateTimeOriginal/
// CreateDate), not raw file mtime, so a photo lands under the date it's
// shown under everywhere else in the app — see resolveCapturedAtMs in
// imports/capture-time.ts.
describe('EXIF capture time', () => {
  let exifRoot: string;
  let exifFolderName: string;

  /** A real 4x4 JPEG with a genuine embedded EXIF DateTimeOriginal tag
   * (`IFD2` is sharp's grouping key for the Exif sub-IFD), stamped with an
   * mtime in a deliberately DIFFERENT month — bucketing must follow the EXIF
   * date, not the file's mtime. */
  async function putJpegWithExifDate(
    rel: string,
    exifDateTimeOriginal: string,
    mtimeUtc: string,
  ): Promise<void> {
    const { default: sharp } = await import('sharp');
    const abs = path.join(exifRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const buf = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .withMetadata({ exif: { IFD2: { DateTimeOriginal: exifDateTimeOriginal } } })
      .jpeg()
      .toBuffer();
    await fs.writeFile(abs, buf);
    const when = new Date(mtimeUtc);
    await fs.utimes(abs, when, when);
  }

  beforeAll(async () => {
    exifRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-exif-'));
    exifFolderName = path.basename(exifRoot);
    // EXIF says June 2019; mtime says November 2024 — bucketing must follow EXIF.
    await putJpegWithExifDate('IMG_9001.jpg', '2019:06:15 10:30:00', '2024-11-01T00:00:00Z');
  });

  afterAll(async () => {
    await fs.rm(exifRoot, { recursive: true, force: true });
  });

  test('scanFolder buckets by EXIF capture time, not file mtime', async () => {
    const res = await scanFolder(exifRoot);
    expect(res.buckets.map((b) => b.key)).toEqual(['2019/06']);
  });

  test('buildImportFiles places the file under the EXIF-derived year', async () => {
    const files = await buildImportFiles(exifRoot, {});
    const img = files.find((f) => f.dest.endsWith('IMG_9001.jpg'))!;
    expect(img.dest).toBe(`2019/misc/${exifFolderName}/IMG_9001.jpg`);
  });

  test('falls back to file mtime when a file has no parseable EXIF date', async () => {
    // A plain-text stand-in for a RAW file (not real image bytes) — exifr
    // can't parse it, so resolveCapturedAtMs falls back to mtime rather than
    // failing the file.
    const abs = path.join(exifRoot, 'NO_EXIF.dng');
    await fs.writeFile(abs, 'not a real DNG');
    const when = new Date('2015-01-10T00:00:00Z');
    await fs.utimes(abs, when, when);

    const files = await buildImportFiles(exifRoot, {});
    const f = files.find((ff) => ff.dest.endsWith('NO_EXIF.dng'))!;
    expect(f.dest).toBe(`2015/misc/${exifFolderName}/NO_EXIF.dng`);
  });
});

describe('scanFolder: defaultDest and nearbyMatchCount preview', () => {
  let previewRoot: string;
  let previewFolderName: string;

  beforeAll(async () => {
    previewRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-preview-'));
    previewFolderName = path.basename(previewRoot);
    const abs = path.join(previewRoot, 'IMG_0001.dng');
    await fs.writeFile(abs, 'content');
    const when = new Date('2024-04-01T00:00:00Z');
    await fs.utimes(abs, when, when);
  });

  afterAll(async () => {
    await fs.rm(previewRoot, { recursive: true, force: true });
  });

  test('reports the misc default destination with no nearby matches when no library is given', async () => {
    const res = await scanFolder(previewRoot);
    const bucket = res.buckets.find((b) => b.key === '2024/04')!;
    expect(bucket.defaultDest).toBe(`2024/misc/${previewFolderName}`);
    expect(bucket.nearbyMatchCount).toBe(0);
    expect(bucket.nearbyMatchFolders).toEqual([]);
  });

  test('reports a nearby match against the injected candidates', async () => {
    const res = await scanFolder(previewRoot, {
      loadNearbyCandidates: async () => [
        { capturedAtMs: new Date('2024-04-01T00:00:00Z').getTime(), folderPath: '2024/Reunion' },
      ],
    });
    const bucket = res.buckets.find((b) => b.key === '2024/04')!;
    // defaultDest still reflects the misc fallback (what applies with no
    // override AND no nearby match); nearbyMatchCount/Folders carry the
    // divergence separately so the UI can show both.
    expect(bucket.defaultDest).toBe(`2024/misc/${previewFolderName}`);
    expect(bucket.nearbyMatchCount).toBe(1);
    expect(bucket.nearbyMatchFolders).toEqual(['2024/Reunion']);
  });

  test('nearbyMatchCount includes a matched primary AND its sidecar', async () => {
    // A second image (with a sidecar) captured at the same instant as the
    // first, still in previewRoot.
    const abs = path.join(previewRoot, 'IMG_0002.dng');
    const xmp = path.join(previewRoot, 'IMG_0002.xmp');
    await fs.writeFile(abs, 'content');
    await fs.writeFile(xmp, 'content');
    const when = new Date('2024-04-01T00:00:00Z');
    await fs.utimes(abs, when, when);
    await fs.utimes(xmp, when, when);

    const res = await scanFolder(previewRoot, {
      loadNearbyCandidates: async () => [
        { capturedAtMs: when.getTime(), folderPath: '2024/Reunion' },
      ],
    });
    const bucket = res.buckets.find((b) => b.key === '2024/04')!;
    // IMG_0001.dng (no sidecar) + IMG_0002.dng + its IMG_0002.xmp sidecar,
    // all three matching → 3, not 2.
    expect(bucket.nearbyMatchCount).toBe(3);
  });
});
