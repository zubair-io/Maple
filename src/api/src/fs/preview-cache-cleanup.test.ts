/**
 * Pure-string tests for `sourceFilenameForPreviewCacheName` — no Mongo, no
 * filesystem. `cleanPreviewsCacheForLocation`'s actual disk-cleanup
 * behavior is exercised indirectly via `missing-reaper.test.ts`/
 * `dedupe.test.ts` (its real callers).
 */
import { describe, test, expect } from 'bun:test';
import { sourceFilenameForPreviewCacheName } from './preview-cache-cleanup.ts';

describe('sourceFilenameForPreviewCacheName', () => {
  test('recovers the source filename for each recognized suffix', () => {
    // One unversioned preview per asset (#2017): the bare `.avif` suffix.
    expect(sourceFilenameForPreviewCacheName('IMG_0001.dng.avif')).toBe('IMG_0001.dng');
    expect(sourceFilenameForPreviewCacheName('IMG_0001.dng.full.jpg')).toBe('IMG_0001.dng');
    expect(sourceFilenameForPreviewCacheName('IMG_0001.dng.histogram.json')).toBe('IMG_0001.dng');
  });

  // Migration (#2017): pre-KISS files (`<filename>.1280.avif` from the size-
  // keyed scheme, `<filename>.dev_<N>.jpg` from the retired display-preview
  // stage) end in `.avif`/`.jpg` too, but recover to a source filename that
  // carries the old size/version token — which is never a live filename — so
  // they simply orphan out via cache-gc's not-live check.
  test('old size/version-keyed files recover to a non-live source (they orphan out)', () => {
    expect(sourceFilenameForPreviewCacheName('IMG_0001.dng.1280.avif')).toBe('IMG_0001.dng.1280');
    // `.dev_5.jpg` is no longer a recognized suffix at all → null → orphan.
    expect(sourceFilenameForPreviewCacheName('IMG_0001.dng.dev_5.jpg')).toBeNull();
  });

  test('returns null for an unrecognized suffix shape (legacy/orphan)', () => {
    expect(sourceFilenameForPreviewCacheName('a1b2c3d4e5f6a7b8_1280.jpg')).toBeNull();
    expect(sourceFilenameForPreviewCacheName('IMG_0001.dng')).toBeNull();
  });

  // Regression for jules's PR #2006 review: `image.jpg` is a strict string
  // prefix of `image.jpg.bak`, so naive `name.startsWith(live + '.')`
  // prefix matching misattributes one file's cache entry to the other.
  // Anchoring on the closed suffix vocabulary from the end recovers the
  // exact source filename with no ambiguity, regardless of what else is
  // live in the same directory.
  test('does not confuse a file whose name is a strict prefix of another live filename', () => {
    const preview = 'image.jpg.bak.avif';
    // Genuinely generated for "image.jpg.bak" — recovered exactly, not
    // "image.jpg" (a different, also-plausible-looking live file).
    expect(sourceFilenameForPreviewCacheName(preview)).toBe('image.jpg.bak');
    expect(sourceFilenameForPreviewCacheName(preview)).not.toBe('image.jpg');
  });
});
