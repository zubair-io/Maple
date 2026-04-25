// Plan 3 M2.1 — Pipeline snapshot regression spec.
//
// The Angular vitest harness runs under jsdom by default, which does
// not implement WebGL2. The hand-rolled Pipeline class hard-requires
// fp16 framebuffers (RGBA16F + EXT_color_buffer_half_float) which
// even `headless-gl` (Node WebGL polyfill) does not expose under its
// CPU stub.
//
// The canonical M2.1 validation is the standalone dev page at
// /dev/webgl-test (registered behind isDevMode() in
// src/web/projects/maple-hosted/src/app/app.routes.ts). Open that
// page in Chrome / Safari / Firefox 88+ on a host with fp16-capable
// hardware and visually inspect the side-by-side WebGL2 vs Apple
// reference rendering. The page surfaces mean / P95 / max ΔE₀₀
// + per-channel bias against the committed reference.png.
//
// This spec is the NODE-side guardrail placeholder. When a future
// CI host installs `gl` (headless-gl) and `pngjs` AND a host driver
// that exposes EXT_color_buffer_half_float, replace the placeholder
// below with a real ΔE₀₀ assertion. Until then the snapshot test
// lives in the Apple-side WebglParityFixtureGenerator and the dev
// page.
//
// Plan 3 M2.4 will add a parity gate on the 100MP Hasselblad fixture
// — that's the right place to close any remaining matrix-layout
// drift between Apple Metal and our GLSL shaders.

import { describe, it, expect } from 'vitest';

import { computeDeltaEStats } from './delta-e-2000';

describe('Pipeline — snapshot ΔE₀₀ regression (Plan 3 M2.1)', () => {
  it.skip(
    'pipeline snapshot regression: skipped under jsdom (no WebGL2 + no fp16). ' +
      'Validate via the dev page at /dev/webgl-test or the Apple-side ' +
      'WebglParityFixtureGenerator Swift test. M2.4 (parity gate) is the ' +
      'right place for an automated CI assertion.',
    () => {
      expect(true).toBe(true);
    },
  );

  // Lightweight regression: prove the CIEDE2000 helper is wired up and
  // numerically stable on a known input. This is a guardrail for the
  // ΔE math (not the WebGL chain itself); identical-buffers must
  // produce ΔE = 0.
  it('computeDeltaEStats returns 0 for identical buffers', () => {
    const a = new Uint8ClampedArray([
      // 2x1 pixels, RGBA8
      128, 64, 32, 255,
      255, 0, 0, 255,
    ]);
    const b = new Uint8ClampedArray(a);
    const stats = computeDeltaEStats(a, b);
    expect(stats.mean).toBeLessThan(1e-6);
    expect(stats.p95).toBeLessThan(1e-6);
    expect(stats.max).toBeLessThan(1e-6);
    expect(stats.biasR).toBe(0);
    expect(stats.biasG).toBe(0);
    expect(stats.biasB).toBe(0);
    expect(stats.nPixels).toBe(2);
  });

  // Numerical sanity: a single 1-byte difference per channel produces
  // a small but non-zero ΔE that's bounded above by ~3.0 ΔE₀₀ at the
  // mid-gray point. This locks down the helper's units (so a future
  // refactor doesn't accidentally swap ΔE76 for ΔE2000).
  it('computeDeltaEStats produces small ΔE for 1-LSB perturbation', () => {
    const a = new Uint8ClampedArray([128, 128, 128, 255]);
    const b = new Uint8ClampedArray([129, 129, 129, 255]);
    const stats = computeDeltaEStats(a, b);
    expect(stats.mean).toBeGreaterThan(0);
    expect(stats.mean).toBeLessThan(3.0);
  });
});
