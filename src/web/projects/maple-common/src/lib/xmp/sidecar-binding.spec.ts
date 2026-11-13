import { describe, expect, it } from 'vitest';
import { primarySidecarFilename } from './sidecar-binding';

describe('primary sidecar filenames', () => {
  it.each([
    ['IMG', 'IMG.xmp'],
    ['.dng', '.dng.xmp'],
    ['.mov', '.mov.xmp'],
    ['.hidden.DNG', '.hidden.xmp'],
    ['Shoot.2026/.dng', 'Shoot.2026/.dng.xmp'],
    ['IMG.', 'IMG.xmp'],
    ['IMG.CR3', 'IMG.xmp'],
    ['IMG.JPG', 'IMG.xmp'],
    ['IMG.HEIC', 'IMG.xmp'],
    ['IMG.MOV', 'IMG.MOV.xmp'],
    ['IMG.mp4', 'IMG.mp4.xmp'],
    ['Shoot.2026/IMG', 'Shoot.2026/IMG.xmp'],
    ['Shoot.2026/IMG.CR3', 'Shoot.2026/IMG.xmp'],
  ])('%s writes to %s', (primary, expected) => {
    expect(primarySidecarFilename(primary)).toBe(expected);
    expect(primarySidecarFilename(primary)).not.toBe(primary);
  });
});
