/**
 * Pure RGB histogram binning. No FFI, no I/O — pulled out so the route
 * can stay coherent under unit test without the native dylib in scope.
 *
 * Input: tightly-packed 8-bit RGB samples (the same layout
 * `maple_render_file` writes through `MapleImageBuffer.rgb`). Output: three
 * fixed-length 256-bin arrays — JSON-friendly plain numbers, not typed
 * arrays, so the response body deserialises trivially in TS/Swift clients
 * without a Base64 detour.
 *
 * The shape is intentionally tiny (3 × 256 = 768 numbers ≈ ~4 KB JSON) so
 * the entire histogram crosses the worker postMessage boundary cheaply
 * even at 100 MP — the alternative (shipping the 300 MB RGB buffer back
 * to the main thread) is the whole reason this lives in the worker.
 */

export interface HistogramBins {
  r: number[];
  g: number[];
  b: number[];
}

/**
 * Count 8-bit channel occurrences across an RGB buffer.
 *
 * Throws on a malformed buffer (`length % 3 !== 0`) so a corrupt FFI
 * result is loud at the binning seam instead of silently producing a
 * skewed histogram. Callers in the route translate the throw into a 500.
 *
 * Assumes the canonical RGB888 layout the Rust core ships through FFI
 * (`maple_render_file` → `MapleImageBuffer.rgb` is `width * height * 3`
 * bytes). The optional `width`/`height` parameters are *only* used as a
 * sanity check — when both are provided the function verifies
 * `width * height * 3 === rgb.length` and throws if not. This catches the
 * "stride is 4, not 3" foot-gun cleanly (#633 review hint).
 */
export function computeHistogram(
  rgb: Uint8Array,
  width?: number,
  height?: number,
): HistogramBins {
  if (rgb.length % 3 !== 0) {
    throw new Error(
      `computeHistogram: buffer length ${rgb.length} is not a multiple of 3 (expected RGB888 stride)`,
    );
  }
  if (typeof width === 'number' && typeof height === 'number') {
    const expected = width * height * 3;
    if (expected !== rgb.length) {
      throw new Error(
        `computeHistogram: buffer length ${rgb.length} does not match width*height*3 = ${expected}`,
      );
    }
  }
  const r = new Array<number>(256).fill(0);
  const g = new Array<number>(256).fill(0);
  const b = new Array<number>(256).fill(0);
  const n = rgb.length;
  for (let i = 0; i < n; i += 3) {
    r[rgb[i]] += 1;
    g[rgb[i + 1]] += 1;
    b[rgb[i + 2]] += 1;
  }
  return { r, g, b };
}
