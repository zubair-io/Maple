import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import exifStage, { isLikelyScreenshot } from './exif.ts';
import { EXIF_PICK_TAGS } from '../../indexer/exif.ts';

function makeDoc(absPath: string, libraryId: ObjectId, libraryRoot: string) {
  const relDir = path.relative(libraryRoot, path.dirname(absPath));
  return {
    _id: '000000000000000000000002' as unknown as ObjectId,
    fileinfo: [
      {
        path: relDir === '.' || relDir === '' ? '' : relDir.split(path.sep).join('/'),
        filename: path.basename(absPath),
        library_id: libraryId,
        deleted_at: null,
      },
    ],
    sha1_head: 'a'.repeat(40),
    maple_id: 'b'.repeat(32),
    stages: {
      exif: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      thumb: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      face: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      geocode: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      meili: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
    },
  };
}

describe('exif handler', () => {
  let dir: string;
  let libraryId: ObjectId;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'exif-stage-'));
    libraryId = new ObjectId();
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    setLibraryRootsForTests(new Map([[libraryId.toHexString(), dir]]));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    setLibraryRootsForTests(null);
  });

  it('returns a patch with an exif key for a file without EXIF', async () => {
    // A raw JPEG with no metadata — exifr returns null; handler must still
    // return a patch (with exif: null) so the runtime can mark the stage done.
    const file = path.join(dir, 'no-exif.jpg');
    const { default: sharp } = await import('sharp');
    const buf = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file, libraryId, dir);
    const result = await exifStage.handler(doc as never, {} as never);

    expect('patch' in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };
    // exif may be null (no EXIF data) — that is a valid and expected value.
    expect('exif' in patch).toBe(true);
  });

  it('patch.exif contains camera_make when a DNG fixture is present', async () => {
    const dng = path.resolve(process.cwd(), '../../test-fixtures/raws/test_0017.dng');
    try {
      await import('node:fs/promises').then((f) => f.stat(dng));
    } catch {
      return; // fixture absent — soft pass on CI
    }
    // DNG lives outside the test library — extend the cache so its
    // directory is also a registered library root.
    const rawLibraryId = new ObjectId();
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    setLibraryRootsForTests(
      new Map([
        [libraryId.toHexString(), dir],
        [rawLibraryId.toHexString(), path.dirname(dng)],
      ]),
    );
    const doc = makeDoc(dng, rawLibraryId, path.dirname(dng));
    const result = await exifStage.handler(doc as never, {} as never);
    const { patch } = result as { patch: Record<string, unknown> };
    const exif = patch.exif as Record<string, unknown> | null;
    expect(exif).not.toBeNull();
    expect(typeof exif?.camera_make).toBe('string');
    setLibraryRootsForTests(new Map([[libraryId.toHexString(), dir]]));
  });

  it('throws when the file does not exist', async () => {
    const doc = makeDoc(path.join(dir, 'ghost.jpg'), libraryId, dir);
    await expect(exifStage.handler(doc as never, {} as never)).rejects.toThrow();
  });

  // exifr's `pick` filter only reads listed tags. If GPSLatitudeRef /
  // GPSLongitudeRef are not picked, exifr's internal DMS-to-DD conversion
  // sees direction=undefined and never negates — every western/southern
  // coordinate comes out positive. Removing these from the pick list
  // silently breaks every photo south of the equator or west of Greenwich.
  it('picks GPS hemisphere refs so exifr applies coordinate sign', () => {
    expect(EXIF_PICK_TAGS).toContain('GPSLatitudeRef');
    expect(EXIF_PICK_TAGS).toContain('GPSLongitudeRef');
  });

  it('exif stage targetVersion is at least 2 (post-GPS-sign-fix)', () => {
    expect(exifStage.targetVersion).toBeGreaterThanOrEqual(2);
  });

  it('flags is_screenshot for a no-EXIF iOS-style filename', async () => {
    const file = path.join(dir, 'Screenshot 2026-05-19 at 10.04.32.png');
    const { default: sharp } = await import('sharp');
    const buf = await sharp({
      create: { width: 8, height: 16, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    await writeFile(file, buf);
    const doc = makeDoc(file, libraryId, dir);
    const result = await exifStage.handler(doc as never, {} as never);
    const { patch } = result as { patch: Record<string, unknown> };
    expect(patch.is_screenshot).toBe(true);
  });

  it('does NOT flag is_screenshot for a regular JPEG without EXIF', async () => {
    const file = path.join(dir, 'vacation.jpg');
    const { default: sharp } = await import('sharp');
    const buf = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);
    const doc = makeDoc(file, libraryId, dir);
    const result = await exifStage.handler(doc as never, {} as never);
    const { patch } = result as { patch: Record<string, unknown> };
    expect(patch.is_screenshot).toBe(false);
  });
});

describe('isLikelyScreenshot — heuristic', () => {
  it('matches iOS screenshot filenames', () => {
    expect(isLikelyScreenshot('Screenshot 2026-05-19 at 10.04.32.png', null)).toBe(true);
    expect(isLikelyScreenshot('Screenshot 2024-12-01.png', '')).toBe(true);
  });

  it('matches macOS Screen Shot filenames', () => {
    expect(isLikelyScreenshot('Screen Shot 2024-12-01 at 1.23.45 PM.png', null)).toBe(true);
  });

  it('matches Android screenshot filenames', () => {
    expect(isLikelyScreenshot('Screenshot_20240601_102030.png', null)).toBe(true);
    expect(isLikelyScreenshot('Screenshot_2024-06-01.png', undefined)).toBe(true);
  });

  it('does not match when a camera_make is present', () => {
    // Pathological filename but the camera tag wins — these are e.g. renamed
    // photos imported from a phone.
    expect(isLikelyScreenshot('Screenshot 2024-01-01.png', 'Apple')).toBe(false);
  });

  it('does not match generic photo filenames', () => {
    expect(isLikelyScreenshot('IMG_0042.JPG', null)).toBe(false);
    expect(isLikelyScreenshot('DSC_1234.NEF', null)).toBe(false);
    expect(isLikelyScreenshot('vacation.jpg', null)).toBe(false);
    expect(isLikelyScreenshot('my-screenshot-of-X.png', null)).toBe(false);
  });

  it('handles absolute paths by checking only the basename', () => {
    expect(isLikelyScreenshot('/Users/foo/Pictures/Screenshot 2026-05-19.png', null)).toBe(true);
    expect(isLikelyScreenshot('/Users/foo/Screenshots/IMG_0042.JPG', null)).toBe(false);
  });
});
