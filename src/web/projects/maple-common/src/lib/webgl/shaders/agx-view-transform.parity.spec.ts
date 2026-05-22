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
