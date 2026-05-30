/**
 * Pure-binning unit tests. No FFI, no Mongo — covers the bin/stride
 * invariants the route relies on.
 */

import { describe, expect, it } from 'bun:test';
import { computeHistogram } from './histogram.ts';

describe('computeHistogram', () => {
  it('produces 256-bin arrays for every channel', () => {
    const h = computeHistogram(new Uint8Array(3));
    expect(h.r.length).toBe(256);
    expect(h.g.length).toBe(256);
    expect(h.b.length).toBe(256);
  });

  it('counts a single sample into the matching bin per channel', () => {
    const h = computeHistogram(new Uint8Array([10, 20, 30]));
    expect(h.r[10]).toBe(1);
    expect(h.g[20]).toBe(1);
    expect(h.b[30]).toBe(1);
    // Spot-check that adjacent bins stayed zero.
    expect(h.r[9]).toBe(0);
    expect(h.g[21]).toBe(0);
    expect(h.b[31]).toBe(0);
  });

  it('aggregates a constant buffer into a single spike per channel', () => {
    // 4 pixels, all (128, 64, 200) → expect spikes at those bins.
    const pixels = 4;
    const rgb = new Uint8Array(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      rgb[i * 3] = 128;
      rgb[i * 3 + 1] = 64;
      rgb[i * 3 + 2] = 200;
    }
    const h = computeHistogram(rgb);
    expect(h.r[128]).toBe(pixels);
    expect(h.g[64]).toBe(pixels);
    expect(h.b[200]).toBe(pixels);
    // Sum of each channel equals pixel count.
    expect(h.r.reduce((s, v) => s + v, 0)).toBe(pixels);
    expect(h.g.reduce((s, v) => s + v, 0)).toBe(pixels);
    expect(h.b.reduce((s, v) => s + v, 0)).toBe(pixels);
  });

  it('handles the full 0..255 dynamic range', () => {
    // One pixel per (k, k, k) — uniform diagonal.
    const rgb = new Uint8Array(256 * 3);
    for (let k = 0; k < 256; k++) {
      rgb[k * 3] = k;
      rgb[k * 3 + 1] = k;
      rgb[k * 3 + 2] = k;
    }
    const h = computeHistogram(rgb);
    for (let k = 0; k < 256; k++) {
      expect(h.r[k]).toBe(1);
      expect(h.g[k]).toBe(1);
      expect(h.b[k]).toBe(1);
    }
  });

  it('throws when the buffer length is not a multiple of 3', () => {
    expect(() => computeHistogram(new Uint8Array(7))).toThrow(/multiple of 3/);
  });

  it('throws when (width, height) disagree with buffer length', () => {
    // 2x2 image = 12 bytes; pass a 9-byte buffer.
    expect(() => computeHistogram(new Uint8Array(9), 2, 2)).toThrow(
      /does not match width\*height\*3/,
    );
  });

  it('accepts buffers whose (width, height) match', () => {
    const rgb = new Uint8Array(2 * 3 * 3); // 2x3 image = 18 bytes
    expect(() => computeHistogram(rgb, 2, 3)).not.toThrow();
  });
});
