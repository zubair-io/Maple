import { describe, expect, it } from 'vitest';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';
import { SCOPE_COLUMNS, VECTORSCOPE_SAMPLES, scopeSampleFromPixels } from './scope-sample';

/** A `width`×`height` frame whose left half is pure red and right half pure blue. */
function halfRedHalfBlue(width: number, height: number): DecodedImage {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (x < width / 2) rgb[i] = 255;
      else rgb[i + 2] = 255;
    }
  }
  return { width, height, rgb, asShotTemperature: 6500, asShotTint: 0 };
}

describe('scopeSampleFromPixels', () => {
  const sample = scopeSampleFromPixels(halfRedHalfBlue(128, 8));

  it('produces peak-relative 256-bin RGB histograms', () => {
    expect(sample.histogram.r).toHaveLength(256);
    expect(sample.histogram.r[255]).toBe(1);
    expect(sample.histogram.r[0]).toBe(1);
    expect(sample.histogram.g[0]).toBe(1);
    expect(sample.histogram.g[255]).toBe(0);
    expect(sample.histogram.b[255]).toBe(1);
  });

  it('parades the red half on the left and the blue half on the right', () => {
    expect(sample.parade.r).toHaveLength(SCOPE_COLUMNS);
    expect(sample.parade.r[0]).toBe(1);
    expect(sample.parade.r[SCOPE_COLUMNS - 1]).toBe(0);
    expect(sample.parade.b[0]).toBe(0);
    expect(sample.parade.b[SCOPE_COLUMNS - 1]).toBe(1);
    expect(sample.parade.g.every((v) => v === 0)).toBe(true);
  });

  it('draws the luma waveform from the same columns', () => {
    expect(sample.waveformLuma).toHaveLength(SCOPE_COLUMNS);
    expect(sample.waveformLuma[0]).toBeCloseTo(0.2126, 4);
    expect(sample.waveformLuma[SCOPE_COLUMNS - 1]).toBeCloseTo(0.0722, 4);
  });

  it('subsamples the chroma cloud to the vectorscope budget', () => {
    expect(sample.vectorscope.length).toBeLessThanOrEqual(VECTORSCOPE_SAMPLES);
    expect(sample.vectorscope.length).toBeGreaterThan(0);
    for (const dot of sample.vectorscope) {
      expect(dot.r + dot.g + dot.b).toBe(1);
    }
  });

  it('stays finite on an empty or all-black frame', () => {
    const empty = scopeSampleFromPixels({
      width: 0,
      height: 0,
      rgb: new Uint8Array(0),
      asShotTemperature: 6500,
      asShotTint: 0,
    });
    expect(empty.vectorscope).toEqual([]);
    expect(empty.waveformLuma.every((v) => v === 0)).toBe(true);
    const black = scopeSampleFromPixels({
      width: 4,
      height: 4,
      rgb: new Uint8Array(48),
      asShotTemperature: 6500,
      asShotTint: 0,
    });
    expect(black.histogram.r[0]).toBe(1);
    expect(black.histogram.r.slice(1).every((v) => v === 0)).toBe(true);
    expect(black.parade.r.every((v) => v === 0)).toBe(true);
  });
});
