// Plan 3 M2.1 — generate a 16x16 synthesized fp16 RGBA input.
//
// The image is a 16x16 grid of scene-linear Rec.2020 colors covering
// the [0.06, 4.0] linear range diagonally with mild chroma variation.
// Designed to exercise every shader stage:
//   * White Balance        — non-neutral chroma per row
//   * SceneToneControls    — linear range up to 4x scene-linear
//   * SceneVibrance        — hue rotation across the grid
//   * SceneSaturation      — chroma swept from 0 to 0.4 in Oklab
//   * AgXViewTransform     — input range covers AgX min..max EV
//
// Run from repo root:
//   bun run src/web/projects/maple-common/src/lib/webgl/dev/fixtures/scripts/generate-synthetic-input.ts
//
// Writes: ../synthetic-input.bin (2048 bytes = 16*16*4*2).
//
// The Apple-side fixture generator
// (src/apple/Packages/MapleCore/Tests/MapleCoreTests/WebglParityFixtureGenerator.swift)
// reads the same bytes and renders the Apple Metal reference PNG; the
// WebGL side reads the same bytes through Pipeline.render(). Drift is
// caught by the snapshot test in pipeline.spec.ts.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function f32ToF16Bits(x: number): number {
  // IEEE 754 round-to-nearest-even f32 -> f16. Matches the WebGL
  // gl.HALF_FLOAT internalformat reader exactly. Standard Imagine-style
  // bit-twiddle implementation.
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = x;
  const bits = u32[0];
  const sign = (bits >>> 16) & 0x8000;
  let val = (bits & 0x7fffffff) + 0x1000;
  if (val >= 0x47800000) {
    if ((bits & 0x7fffffff) >= 0x47800000) {
      if (val < 0x7f800000) return sign | 0x7c00;
      return sign | 0x7c00 | ((bits & 0x007fffff) >>> 13);
    }
    return sign | 0x7bff;
  }
  if (val >= 0x38800000) return sign | ((val - 0x38000000) >>> 13);
  if (val < 0x33000000) return sign;
  val = (bits & 0x7fffffff) >>> 23;
  return (
    sign |
    ((((bits & 0x7fffff) | 0x800000) + (0x800000 >>> (val - 102))) >>> (126 - val))
  );
}

function main(): void {
  const w = 16;
  const h = 16;
  const lanes = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      // Scene-linear values in [0.06, 4.0] swept diagonally.
      const t = (x + y) / (w + h - 2); // 0..1
      const lin = 0.001 + Math.pow(2, t * 12 - 4); // ~0.06 .. 4.0
      // Mild chroma variation: shift R up, B down across rows.
      const r = lin * (1.0 + 0.2 * Math.sin((x / w) * Math.PI * 2));
      const g = lin;
      const b = lin * (1.0 - 0.2 * Math.sin((y / h) * Math.PI * 2));
      const i = (y * w + x) * 4;
      lanes[i + 0] = f32ToF16Bits(Math.max(0, r));
      lanes[i + 1] = f32ToF16Bits(Math.max(0, g));
      lanes[i + 2] = f32ToF16Bits(Math.max(0, b));
      lanes[i + 3] = 0x3c00; // alpha = fp16(1.0)
    }
  }
  const dst = resolve(import.meta.dir, '..', 'synthetic-input.bin');
  writeFileSync(dst, Buffer.from(lanes.buffer));
  // eslint-disable-next-line no-console
  console.log(`wrote ${dst} (${lanes.byteLength} bytes, 16x16 fp16 RGBA)`);
}

main();
