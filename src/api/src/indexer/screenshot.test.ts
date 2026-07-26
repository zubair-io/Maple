/**
 * `is_screenshot` is a stills-only concept (#2325). A video container is
 * never a screenshot, however it is named.
 *
 * The camera-make guard in `isLikelyScreenshot` never protected video:
 * every video extension is in `NO_EXIF_EXTS`, so exifr returns no make and
 * the "conservative" branch is dead code for them. The extension test is
 * the real guard, which is why these cases pin it directly.
 */
import { describe, it, expect } from 'bun:test';
import { isScreenshotFilename, isLikelyScreenshot } from './screenshot.ts';

describe('screenshot detection — video containers', () => {
  it('rejects screenshot-named video containers', () => {
    expect(isScreenshotFilename('Screenshot_20240601_102030.mp4')).toBe(false);
    expect(isScreenshotFilename('Screenshot 2026-05-19 at 10.04.32.mov')).toBe(false);
    expect(isScreenshotFilename('Screen Shot 2024-12-01 at 1.23.45 PM.m4v')).toBe(false);
    expect(isScreenshotFilename('Screenshot_2024-06-01.webm')).toBe(false);
  });

  it('is case-insensitive on the extension', () => {
    expect(isScreenshotFilename('Screenshot_20240601.MP4')).toBe(false);
    expect(isScreenshotFilename('Screenshot_20240601.MOV')).toBe(false);
  });

  it('rejects video paths, not just bare filenames', () => {
    expect(isScreenshotFilename('/lib/2024/Screenshot/Screenshot 2024-06-01.mov')).toBe(false);
  });

  it('rejects video through isLikelyScreenshot for every camera_make shape', () => {
    expect(isLikelyScreenshot('Screenshot_20240601_102030.mp4', null)).toBe(false);
    expect(isLikelyScreenshot('Screenshot_20240601_102030.mp4', '')).toBe(false);
    expect(isLikelyScreenshot('Screenshot_20240601_102030.mp4', undefined)).toBe(false);
    expect(isLikelyScreenshot('Screenshot_20240601_102030.mp4', 'Apple')).toBe(false);
  });
});

describe('screenshot detection — stills are unchanged', () => {
  it('still accepts screenshot-named stills', () => {
    expect(isScreenshotFilename('Screenshot 2026-05-19 at 10.04.32.png')).toBe(true);
    expect(isScreenshotFilename('Screen Shot 2024-12-01 at 1.23.45 PM.png')).toBe(true);
    expect(isLikelyScreenshot('Screenshot_20240601_102030.png', null)).toBe(true);
  });

  it('still rejects non-screenshot stills and mid-name matches', () => {
    expect(isScreenshotFilename('IMG_0042.JPG')).toBe(false);
    expect(isScreenshotFilename('my-screenshot-of-X.png')).toBe(false);
    expect(isLikelyScreenshot('Screenshot 2024-01-01.png', 'Apple')).toBe(false);
  });
});
