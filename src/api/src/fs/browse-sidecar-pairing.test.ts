/**
 * Unit coverage for `canonicalBaseFromSidecarFilename` — the pure helper that
 * resolves an `.xmp` sidecar filename to the filename of the primary it pairs
 * to. Pure string math, no Mongo / filesystem.
 *
 * Two conventions live side by side (M5 — #1635):
 *   - images: stem-swap   `IMG_1.xmp`     → base `IMG_1`     (pairs by stem)
 *   - videos: full-name   `clip.mov.xmp`  → base `clip.mov`  (pairs by full name)
 * The split is what keeps an Apple Live Photo's motion clip from clobbering the
 * same-stem still: their sidecars resolve to DIFFERENT bases.
 */
import { describe, test, expect } from 'bun:test';
import { canonicalBaseFromSidecarFilename } from './browse.ts';

describe('canonicalBaseFromSidecarFilename', () => {
  test('image stem-swap sidecar → stem (no extension)', () => {
    expect(canonicalBaseFromSidecarFilename('IMG_1.xmp')).toBe('IMG_1');
    expect(canonicalBaseFromSidecarFilename('clip.xmp')).toBe('clip');
  });

  test('video full-name sidecar → full filename incl. video extension', () => {
    expect(canonicalBaseFromSidecarFilename('clip.mov.xmp')).toBe('clip.mov');
    expect(canonicalBaseFromSidecarFilename('IMG_1234.MOV.xmp')).toBe('IMG_1234.MOV');
    expect(canonicalBaseFromSidecarFilename('movie.mp4.xmp')).toBe('movie.mp4');
  });

  test('Live Photo: still + clip sidecars resolve to DIFFERENT bases', () => {
    const still = canonicalBaseFromSidecarFilename('IMG_1234.xmp'); // photo
    const clip = canonicalBaseFromSidecarFilename('IMG_1234.MOV.xmp'); // motion
    expect(still).toBe('IMG_1234');
    expect(clip).toBe('IMG_1234.MOV');
    expect(still).not.toBe(clip); // different keys → no collision
  });

  test('conflict-copy sidecar still resolves to the image stem', () => {
    expect(canonicalBaseFromSidecarFilename('IMG_1 (conflict from MacBook).xmp')).toBe('IMG_1');
    expect(canonicalBaseFromSidecarFilename('IMG_1 (conflict from MacBook) (2).xmp')).toBe('IMG_1');
  });

  test('non-sidecar filename → null', () => {
    expect(canonicalBaseFromSidecarFilename('notes.txt')).toBeNull();
    expect(canonicalBaseFromSidecarFilename('clip.mov')).toBeNull();
  });
});
