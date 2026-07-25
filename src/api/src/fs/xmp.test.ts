/**
 * Pure-path-math tests for the cache-path resolvers in `xmp.ts`. No Mongo, no
 * filesystem. BOTH tiers are path-keyed off the source's own filename — thumbs
 * as `sha256_prefix16(filename)`, previews as `<filename>.<suffix>` — so every
 * resolver names a file that can be found from a path alone, with no DB lookup.
 * See `resolveThumbPathForAsset`'s doc for why thumbs are not content-addressed.
 *
 * The skip-when-Mongo-unreachable pattern from `libraries.cache.test.ts` is
 * not needed here.
 */
import { describe, test, expect } from 'bun:test';
import { ObjectId } from 'mongodb';
import * as path from 'node:path';
import {
  resolveThumbPath,
  resolveThumbPathForAsset,
  cachePathForAsset,
  sha256Prefix16,
  xmpSidecarPath,
} from './xmp.ts';

const LIB_ID = new ObjectId('1234567890abcdef12345678');
const LIB_ROOT = '/srv/library';
const MAPLE_ID = 'a'.repeat(32);

function libs(): ReadonlyMap<string, string> {
  return new Map([[LIB_ID.toHexString(), LIB_ROOT]]);
}

function makeAsset(opts: {
  /** Pass `null` to omit maple_id explicitly; default is MAPLE_ID. */
  maple_id?: string | null;
  fileinfoPath?: string;
  filename?: string;
  library_id?: ObjectId;
  noFileinfo?: boolean;
}): {
  maple_id?: string;
  fileinfo?: { path: string; filename: string; library_id: ObjectId }[];
} {
  const mid = opts.maple_id === null ? undefined : (opts.maple_id ?? MAPLE_ID);
  const base: { maple_id?: string } = mid !== undefined ? { maple_id: mid } : {};
  if (opts.noFileinfo) return base;
  return {
    ...base,
    fileinfo: [
      {
        path: opts.fileinfoPath ?? 'vacation/2024',
        filename: opts.filename ?? 'IMG_001.dng',
        library_id: opts.library_id ?? LIB_ID,
      },
    ],
  };
}

describe('xmpSidecarPath', () => {
  test('RAW/image uses stem-swap: IMG_1.ARW → IMG_1.xmp', () => {
    expect(xmpSidecarPath('/photos/IMG_1.ARW')).toBe('/photos/IMG_1.xmp');
    expect(xmpSidecarPath('/photos/clip.heic')).toBe('/photos/clip.xmp');
    expect(xmpSidecarPath('/photos/clip.jpg')).toBe('/photos/clip.xmp');
  });

  test('video keeps its extension (full-name): clip.mov → clip.mov.xmp (M5 — #1635)', () => {
    expect(xmpSidecarPath('/photos/clip.mov')).toBe('/photos/clip.mov.xmp');
    expect(xmpSidecarPath('/photos/clip.mp4')).toBe('/photos/clip.mp4.xmp');
  });

  test('video extension match is case-insensitive: IMG_1234.MOV → IMG_1234.MOV.xmp', () => {
    expect(xmpSidecarPath('/photos/IMG_1234.MOV')).toBe('/photos/IMG_1234.MOV.xmp');
  });

  test('Live Photo: same-stem still + clip resolve to DIFFERENT sidecars', () => {
    const still = xmpSidecarPath('/photos/IMG_1234.HEIC');
    const clip = xmpSidecarPath('/photos/IMG_1234.MOV');
    expect(still).toBe('/photos/IMG_1234.xmp');
    expect(clip).toBe('/photos/IMG_1234.MOV.xmp');
    expect(still).not.toBe(clip); // no clobber
  });
});

describe('resolveThumbPathForAsset', () => {
  // THE load-bearing assertion: the DB-side resolver and the bare-path resolver
  // must name the same file. When they disagreed (`maple_id` vs basename hash)
  // the `thumb` stage wrote one name and `/api/fs/thumb` looked for the other,
  // so every browse/timeline request re-decoded a source that already had a
  // valid thumb sitting in the same directory — 2.6s vs 1.3ms per image.
  test('agrees with resolveThumbPath for the same file', () => {
    const abs = path.join(LIB_ROOT, 'vacation', '2024', 'IMG_001.dng');
    expect(resolveThumbPathForAsset(makeAsset({}), libs())).toBe(resolveThumbPath(abs));
  });

  test('composes <lib>/<fileinfo[0].path>/.maple/thumbs/<sha256_prefix16(filename)>.avif', () => {
    const result = resolveThumbPathForAsset(makeAsset({}), libs());
    const key = sha256Prefix16('IMG_001.dng');
    expect(result).toBe(path.join(LIB_ROOT, 'vacation', '2024', '.maple', 'thumbs', `${key}.avif`));
  });

  test('fileinfo[0].path === "" → <lib>/.maple/thumbs/<key>.avif (file at library root)', () => {
    const result = resolveThumbPathForAsset(makeAsset({ fileinfoPath: '' }), libs());
    expect(result).toBe(
      path.join(LIB_ROOT, '.maple', 'thumbs', `${sha256Prefix16('IMG_001.dng')}.avif`),
    );
  });

  test('POSIX path split: "a/b/c" → segments joined via path.join (never raw "/" in result)', () => {
    const result = resolveThumbPathForAsset(makeAsset({ fileinfoPath: 'a/b/c' }), libs());
    const key = sha256Prefix16('IMG_001.dng');
    expect(result).toBe(path.join(LIB_ROOT, 'a', 'b', 'c', '.maple', 'thumbs', `${key}.avif`));
  });

  // Was "returns null when maple_id is missing". Path-keying removed that
  // dependency, so a not-yet-hashed row now resolves instead of being skipped.
  test('resolves without a maple_id (no longer part of the key)', () => {
    const result = resolveThumbPathForAsset(makeAsset({ maple_id: null }), libs());
    expect(result).toBe(resolveThumbPathForAsset(makeAsset({}), libs()));
    expect(result).not.toBeNull();
  });

  test('the key is the filename, so two names in one folder do not collide', () => {
    const a = resolveThumbPathForAsset(makeAsset({ filename: 'IMG_001.dng' }), libs());
    const b = resolveThumbPathForAsset(makeAsset({ filename: 'IMG_001 copy.dng' }), libs());
    expect(a).not.toBe(b);
  });

  test('returns null when library_id is not in the libraries map', () => {
    const result = resolveThumbPathForAsset(
      makeAsset({ library_id: new ObjectId('ffffffffffffffffffffffff') }),
      libs(),
    );
    expect(result).toBeNull();
  });

  test('returns null when fileinfo is empty or absent', () => {
    const result = resolveThumbPathForAsset(makeAsset({ noFileinfo: true }), libs());
    expect(result).toBeNull();
    // Explicit empty-fileinfo case: `fileinfo[]` exists on the doc but is
    // an empty array (post-PR-6 invariant violation we still want to handle).
    // Typed via the same shape `makeAsset` returns so no cast is needed.
    const emptyFileinfo: {
      maple_id: string;
      fileinfo: { path: string; filename: string; library_id: ObjectId }[];
    } = { maple_id: MAPLE_ID, fileinfo: [] };
    const result2 = resolveThumbPathForAsset(emptyFileinfo, libs());
    expect(result2).toBeNull();
  });
});

describe('cachePathForAsset', () => {
  test('thumbs kind delegates to the path-keyed resolveThumbPathForAsset', () => {
    const result = cachePathForAsset(makeAsset({}), libs(), 'thumbs');
    expect(result).toBe(resolveThumbPathForAsset(makeAsset({}), libs()));
    expect(result).toBe(
      path.join(
        LIB_ROOT,
        'vacation',
        '2024',
        '.maple',
        'thumbs',
        `${sha256Prefix16('IMG_001.dng')}.avif`,
      ),
    );
  });

  test('previews with explicit suffix: kind="previews", suffix="1280.avif" → <filename>.1280.avif', () => {
    const result = cachePathForAsset(makeAsset({}), libs(), 'previews', '1280.avif');
    expect(result).toBe(
      path.join(LIB_ROOT, 'vacation', '2024', '.maple', 'previews', 'IMG_001.dng.1280.avif'),
    );
  });

  // The `suffix ?? 'full.jpg'` default was removed in #2220: nothing writes a
  // `full.jpg` any more, so the default could only be hit by mistake. `suffix`
  // is now required for `previews` at the type level, which is what this
  // asserts — the @ts-expect-error IS the test, and it fails to compile if the
  // parameter ever goes back to being optional.
  test('previews requires an explicit suffix', () => {
    // @ts-expect-error - suffix is required for kind="previews"
    const result = cachePathForAsset(makeAsset({}), libs(), 'previews');
    // No 'full.jpg' fallback remains at runtime either.
    expect(result).not.toContain('full.jpg');
  });

  test('previews at library root (empty fileinfo[0].path) → no extra segments', () => {
    const result = cachePathForAsset(
      makeAsset({ fileinfoPath: '' }),
      libs(),
      'previews',
      '1280.avif',
    );
    expect(result).toBe(path.join(LIB_ROOT, '.maple', 'previews', 'IMG_001.dng.1280.avif'));
  });

  test('previews resolve without maple_id — path-keyed, not content-addressed', () => {
    const result = cachePathForAsset(
      makeAsset({ maple_id: null }),
      libs(),
      'previews',
      '1280.avif',
    );
    expect(result).toBe(
      path.join(LIB_ROOT, 'vacation', '2024', '.maple', 'previews', 'IMG_001.dng.1280.avif'),
    );
  });

  test('thumbs resolve without a maple_id — it is not part of the key', () => {
    const result = cachePathForAsset(makeAsset({ maple_id: null }), libs(), 'thumbs');
    expect(result).toBe(cachePathForAsset(makeAsset({}), libs(), 'thumbs'));
    expect(result).not.toBeNull();
  });

  test('returns null when fileinfo is absent', () => {
    const result = cachePathForAsset(
      makeAsset({ noFileinfo: true }),
      libs(),
      'previews',
      '1280.avif',
    );
    expect(result).toBeNull();
  });

  test('returns null when library_id is not in the libraries map', () => {
    const result = cachePathForAsset(
      makeAsset({ library_id: new ObjectId('ffffffffffffffffffffffff') }),
      libs(),
      'previews',
      '1280.avif',
    );
    expect(result).toBeNull();
  });
});
