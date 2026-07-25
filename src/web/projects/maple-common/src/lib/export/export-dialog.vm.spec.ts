import { describe, it, expect } from 'vitest';
import {
  COLOR_SPACE_CHOICES,
  DEFAULT_QUALITY,
  FORMAT_CHOICES,
  baseName,
  exportFilename,
  outputDimensions,
  supportsQuality,
} from './export-dialog.vm';

describe('export-dialog.vm', () => {
  describe('format and colour-space choices', () => {
    it('offers at least JPEG and 16-bit TIFF, the two formats #943 requires', () => {
      const values = FORMAT_CHOICES.map((c) => c.value);
      expect(values).toContain('jpeg');
      expect(values).toContain('tiff');
    });

    it('offers both sRGB and Display P3', () => {
      const values = COLOR_SPACE_CHOICES.map((c) => c.value);
      expect(values).toEqual(['srgb', 'display-p3']);
    });

    it('gives every choice non-empty help copy', () => {
      for (const choice of [...FORMAT_CHOICES, ...COLOR_SPACE_CHOICES]) {
        expect(choice.label.length).toBeGreaterThan(0);
        expect(choice.detail.length).toBeGreaterThan(0);
      }
    });
  });

  describe('supportsQuality', () => {
    it('is true only for JPEG — the lossless formats have no quality knob', () => {
      expect(supportsQuality('jpeg')).toBe(true);
      expect(supportsQuality('tiff')).toBe(false);
      expect(supportsQuality('png')).toBe(false);
    });

    it('has a default quality inside the valid range', () => {
      expect(DEFAULT_QUALITY).toBeGreaterThanOrEqual(1);
      expect(DEFAULT_QUALITY).toBeLessThanOrEqual(100);
    });
  });

  describe('baseName', () => {
    it('strips the extension', () => {
      expect(baseName('IMG_1234.CR3')).toBe('IMG_1234');
    });

    it('strips a directory prefix from a path-shaped filename', () => {
      expect(baseName('trip/day2/IMG_1234.dng')).toBe('IMG_1234');
    });

    it('keeps a name that has no extension', () => {
      expect(baseName('IMG_1234')).toBe('IMG_1234');
    });

    it('keeps a leading dot as part of a dotfile name rather than emptying it', () => {
      expect(baseName('.hidden')).toBe('.hidden');
    });

    it('strips only the last extension of a multi-dot name', () => {
      expect(baseName('a.b.c.dng')).toBe('a.b.c');
    });
  });

  describe('exportFilename', () => {
    it('swaps the original extension for the export format', () => {
      expect(exportFilename('IMG_1234.CR3', 'jpg')).toBe('IMG_1234.jpg');
      expect(exportFilename('IMG_1234.CR3', 'tif')).toBe('IMG_1234.tif');
    });

    it('drops any path prefix so the download name is a bare filename', () => {
      expect(exportFilename('trip/IMG_1.dng', 'png')).toBe('IMG_1.png');
    });
  });

  describe('outputDimensions', () => {
    it('returns the native size when no cap is set', () => {
      expect(outputDimensions(6000, 4000, undefined)).toEqual({ width: 6000, height: 4000 });
      expect(outputDimensions(6000, 4000, 0)).toEqual({ width: 6000, height: 4000 });
    });

    it('caps the long edge and preserves aspect ratio', () => {
      expect(outputDimensions(6000, 4000, 3000)).toEqual({ width: 3000, height: 2000 });
    });

    it('caps the long edge on portrait images too', () => {
      expect(outputDimensions(4000, 6000, 3000)).toEqual({ width: 2000, height: 3000 });
    });

    it('never upscales — a cap above the native long edge is a no-op', () => {
      expect(outputDimensions(1200, 800, 4096)).toEqual({ width: 1200, height: 800 });
      expect(outputDimensions(1200, 800, 1200)).toEqual({ width: 1200, height: 800 });
    });

    it('never rounds a dimension down to zero', () => {
      const size = outputDimensions(10000, 3, 100);
      expect(size.width).toBe(100);
      expect(size.height).toBeGreaterThanOrEqual(1);
    });

    it('tolerates an unknown native size without dividing by zero', () => {
      expect(outputDimensions(0, 0, 2048)).toEqual({ width: 0, height: 0 });
    });
  });
});
