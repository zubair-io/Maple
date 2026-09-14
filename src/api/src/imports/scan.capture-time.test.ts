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
import { maple } from 'maple';
import { solidRgb } from '../test-support/synth-image.ts';
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

  /**
   * A minimal, valid little-endian raw EXIF TIFF block whose Exif sub-IFD
   * carries a real `DateTimeOriginal` tag (0x9003) — the actual nested
   * structure a camera writes (IFD0 → an ExifIFD pointer, tag 0x8769 →
   * the Exif sub-IFD → the tag itself), not a flattened convenience
   * shortcut. Maple's `withExif()` takes this raw form directly (it
   * diverges from the previous library's `{ IFD0: {...} }` object shape — see the
   * @justmaple/maple README's `withExif()` row, tracked upstream as #3588).
   *
   * Layout (byte offsets):
   *   0-7    "II" + magic(42) + offset-to-IFD0(8)
   *   8-25   IFD0: 1 entry — tag 0x8769 (ExifIFD ptr) → offset 26; next-IFD 0
   *   26-43  Exif sub-IFD: 1 entry — tag 0x9003 (DateTimeOriginal), ASCII,
   *          count 20, value offset 44; next-IFD 0
   *   44-63  the 20-byte ASCII string "YYYY:MM:DD HH:MM:SS\0"
   */
  function dateTimeOriginalExifBlock(dateTimeOriginal: string): Buffer {
    const value = `${dateTimeOriginal}\0`;
    if (value.length !== 20) {
      throw new Error(
        `test setup: DateTimeOriginal must be the 19-char "YYYY:MM:DD HH:MM:SS" form, got "${dateTimeOriginal}"`,
      );
    }
    const EXIF_IFD_OFFSET = 26;
    const STRING_OFFSET = 44;
    const buf = Buffer.alloc(STRING_OFFSET + 20);
    buf.write('II', 0, 'ascii');
    buf.writeUInt16LE(42, 2);
    buf.writeUInt32LE(8, 4);
    // IFD0: one entry, the ExifIFD pointer.
    buf.writeUInt16LE(1, 8);
    buf.writeUInt16LE(0x8769, 10);
    buf.writeUInt16LE(4, 12); // type LONG
    buf.writeUInt32LE(1, 14);
    buf.writeUInt32LE(EXIF_IFD_OFFSET, 18);
    buf.writeUInt32LE(0, 22); // no next IFD
    // Exif sub-IFD: one entry, DateTimeOriginal.
    buf.writeUInt16LE(1, EXIF_IFD_OFFSET);
    buf.writeUInt16LE(0x9003, EXIF_IFD_OFFSET + 2);
    buf.writeUInt16LE(2, EXIF_IFD_OFFSET + 4); // type ASCII
    buf.writeUInt32LE(20, EXIF_IFD_OFFSET + 6);
    buf.writeUInt32LE(STRING_OFFSET, EXIF_IFD_OFFSET + 10);
    buf.writeUInt32LE(0, EXIF_IFD_OFFSET + 14); // no next IFD
    buf.write(value, STRING_OFFSET, 'ascii');
    return buf;
  }

  /** A real 4x4 JPEG with a genuine embedded EXIF DateTimeOriginal tag,
   * stamped with an mtime in a deliberately DIFFERENT month — bucketing
   * must follow the EXIF date, not the file's mtime. */
  async function putJpegWithExifDate(
    rel: string,
    exifDateTimeOriginal: string,
    mtimeUtc: string,
  ): Promise<void> {
    const abs = path.join(exifRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const buf = await maple(solidRgb(4, 4, [0, 0, 0]))
      .withExif(dateTimeOriginalExifBlock(exifDateTimeOriginal))
      .toFormat('jpeg')
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

  test('falls back to the filename-encoded date when EXIF is absent (OneDrive convention)', async () => {
    // No parseable EXIF, but the OneDrive camera-roll name encodes the true
    // capture time — bucketing must prefer it over the (much later) mtime.
    const abs = path.join(exifRoot, '20101011_035847220_iOS.jpg');
    await fs.writeFile(abs, 'not a real JPEG');
    const when = new Date('2024-11-01T00:00:00Z');
    await fs.utimes(abs, when, when);

    const files = await buildImportFiles(exifRoot, {});
    const f = files.find((ff) => ff.dest.endsWith('20101011_035847220_iOS.jpg'))!;
    expect(f.dest).toBe(`2010/misc/${exifFolderName}/20101011_035847220_iOS.jpg`);
  });

  test('EXIF capture time wins over a filename-encoded date', async () => {
    // EXIF says June 2019; the filename claims January 2010 — EXIF is
    // authoritative when both are present.
    await putJpegWithExifDate(
      '20100102_121212000_iOS.jpg',
      '2019:06:15 10:30:00',
      '2024-11-01T00:00:00Z',
    );

    const files = await buildImportFiles(exifRoot, {});
    const f = files.find((ff) => ff.dest.endsWith('20100102_121212000_iOS.jpg'))!;
    expect(f.dest).toBe(`2019/misc/${exifFolderName}/20100102_121212000_iOS.jpg`);
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
