// agx-view-transform.parity.spec.ts — GLSL sigmoid self-consistency.
//
// Companion to the Rust-side parity gate (#263). The GLSL math is
// replicated here in plain TypeScript and the test asserts:
//
//   1. Sigmoid value at AGX_X_PIVOT equals AGX_Y_PIVOT (= 0.18) within
//      fp tolerance. Mid-gray on the neutral axis is preserved through
//      the curve.
//   2. The sigmoid is monotone non-decreasing across the 512-entry LUT
//      range.
//   3. Endpoint anchors are 0 (toe) and ~1 (shoulder).
//
// Cross-platform Rust↔GLSL byte-equality is verified on the Rust side by
// `tests::glsl_port_matches_rust_lut` in
// `src/raw-pipeline/raw-core/src/view/agx.rs` — that test ports this
// GLSL math back into Rust and asserts byte-equivalence with the LUT.
// Splitting the test boundary that way avoids needing node:fs / Node
// types in the jsdom Angular spec environment.

import { describe, expect, it } from 'vitest';

// ── GLSL math mirrored in TypeScript ─────────────────────────────────────
// Constants must match `agx-view-transform.ts` exactly. Coefficient
// derivation lives in `src/scripts/derive_agx_lut.py`.
const AGX_X_PIVOT = 10.0 / 16.5; // -AGX_MIN_EV / (AGX_MAX_EV - AGX_MIN_EV)
const AGX_Y_PIVOT = 0.18;
const AGX_SLOPE = 2.4;
const AGX_TOE_POWER = 3.0;
const AGX_SHOULDER_POWER = 3.25;
const AGX_LUT_SIZE = 512;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function equationScale(xPivot: number, yPivot: number, slope: number, power: number): number {
  return Math.pow(
    Math.pow(slope * xPivot, -power) * (Math.pow(slope * (xPivot / yPivot), power) - 1.0),
    -1.0 / power,
  );
}

/** Mirror of `agx_sigmoid` in `agx-view-transform.ts` GLSL. */
function agxSigmoid(x: number): number {
  x = clamp(x, 0.0, 1.0);
  let sideX: number;
  let sideY: number;
  let sidePower: number;
  let scale: number;
  if (x >= AGX_X_PIVOT) {
    sideX = 1.0 - AGX_X_PIVOT;
    sideY = 1.0 - AGX_Y_PIVOT;
    sidePower = AGX_SHOULDER_POWER;
    scale = equationScale(sideX, sideY, AGX_SLOPE, sidePower);
  } else {
    sideX = AGX_X_PIVOT;
    sideY = AGX_Y_PIVOT;
    sidePower = AGX_TOE_POWER;
    scale = -equationScale(sideX, sideY, AGX_SLOPE, sidePower);
  }
  const term = (AGX_SLOPE * (x - AGX_X_PIVOT)) / scale;
  const hyperbolic = term / Math.pow(1.0 + Math.pow(term, sidePower), 1.0 / sidePower);
  return clamp(scale * hyperbolic + AGX_Y_PIVOT, 0.0, 1.0);
}

// ── Bayer 8×8 dither mirror (#441) ───────────────────────────────────────
// Must match the GLSL `BAYER_8X8` array in `agx-view-transform.ts` AND
// the Rust `BAYER_8X8` in `raw-core/src/view/dither.rs`. All three are
// the canonical 8×8 ordered-dither matrix from Wikipedia / the OpenGL
// Programming Guide; if any one of them drifts, the dither pattern goes
// out of phase between Rust and Web output and the cross-platform
// parity claim breaks.
const BAYER_8X8: readonly number[] = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

/** Mirror of `dither_offset_lsb` in `agx-view-transform.ts` GLSL and
 * `bayer_offset_lsb` in `raw-core/src/view/dither.rs`. */
function ditherOffsetLsb(x: number, y: number): number {
  const cell = BAYER_8X8[(y & 7) * 8 + (x & 7)];
  return (cell + 0.5) / 64.0 - 0.5;
}

describe('Bayer 8×8 dither — Web/Rust parity (#441)', () => {
  it('matrix contains each of 0..=63 exactly once', () => {
    const seen = new Array<boolean>(64).fill(false);
    for (const v of BAYER_8X8) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(64);
      expect(seen[v]).toBe(false);
      seen[v] = true;
    }
    expect(seen.every((b) => b)).toBe(true);
  });

  it('offset for every cell lies in [-0.5, +0.5)', () => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const o = ditherOffsetLsb(x, y);
        expect(o).toBeGreaterThanOrEqual(-0.5);
        expect(o).toBeLessThan(0.5);
      }
    }
  });

  it('tile mean offset is zero', () => {
    let sum = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        sum += ditherOffsetLsb(x, y);
      }
    }
    expect(Math.abs(sum)).toBeLessThan(1e-9);
  });

  it('tiles across an image (same cell at (x+8, y), (x, y+8))', () => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const base = ditherOffsetLsb(x, y);
        expect(ditherOffsetLsb(x + 8, y)).toBe(base);
        expect(ditherOffsetLsb(x, y + 8)).toBe(base);
        expect(ditherOffsetLsb(x + 16, y + 16)).toBe(base);
      }
    }
  });
});

describe('AgX view transform — GLSL sigmoid self-consistency (#263)', () => {
  it('lands AGX_Y_PIVOT (=0.18) exactly at AGX_X_PIVOT', () => {
    // Load-bearing claim: mid-gray (norm = X_PIVOT) maps to Y_PIVOT.
    // If this drifts, mid-gray no longer maps to mid-gray through AgX.
    expect(agxSigmoid(AGX_X_PIVOT)).toBeCloseTo(AGX_Y_PIVOT, 9);
  });

  it('is monotone non-decreasing across the 512-entry LUT range', () => {
    let prev = -Infinity;
    for (let i = 0; i < AGX_LUT_SIZE; i++) {
      const x = i / (AGX_LUT_SIZE - 1);
      const y = agxSigmoid(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });

  it('anchors near 0 at x=0 and near 1 at x=1', () => {
    expect(agxSigmoid(0)).toBeLessThan(1e-3);
    expect(agxSigmoid(1)).toBeGreaterThan(0.97);
    expect(agxSigmoid(1)).toBeLessThanOrEqual(1.0);
  });
});
