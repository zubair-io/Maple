// mask-brush.ts — pure brush-mask math for the mask overlay (#360): the
// dab-series rasterizer (a port of `raw_core::types::brush`, so the tint the
// overlay draws IS what the render applies), stroke capture (spacing,
// pressure, smoothing), and the digest + dims helpers the session registers
// with. The RENDER path never touches this file — it samples the worker's
// registered raster; only the tint and the stroke capture run here.

import type { BrushDab, BrushMask, MaskPoint } from '../../models/local-adjustment';
import { applyAffine, type MaskAffine } from './mask-geometry';

// ── Brush defaults ──────────────────────────────────────────────────────────

/** Default brush size as a fraction of the image width. */
export const BRUSH_DEFAULT_SIZE = 0.05;
/** Default soft-edge fraction of the radius (`0` = hard disc). */
export const BRUSH_DEFAULT_FEATHER = 0.5;
/** Default per-dab peak value. */
export const BRUSH_DEFAULT_FLOW = 0.5;

/** Dab spacing as a fraction of the radius — stamps overlap 4×, so even a
 *  fast drag lays an unbroken stroke. */
export const DAB_SPACING = 0.25;
/** Stroke stabilizer: exponential-moving-average alpha toward the raw
 *  pointer point. `1` would disable smoothing entirely. */
export const STROKE_SMOOTHING_ALPHA = 0.4;
/** Pressure response: `radius × (0.5 + 0.5p)`, `weight × (0.25 + 0.75p)` —
 *  a light touch paints small and faint, never invisible. A pressure of `0`
 *  (a device that cannot report any) reads as full pressure, not as none. */
export const PRESSURE_RADIUS_FLOOR = 0.5;
export const PRESSURE_WEIGHT_FLOOR = 0.25;

/** Long edge of a brush raster in texels — mirrors raw-core's
 *  `BRUSH_RASTER_LONG_EDGE`, the same 1024 the Vision person/skin path
 *  registers at. */
export const BRUSH_RASTER_LONG_EDGE = 1024;

/** Aspect-preserving raster dims for an image — mirrors raw-core's
 *  `brush_raster_dims` exactly, so every platform rasterizes the same dab
 *  series onto the same grid. */
export function brushRasterDims(imageWidth: number, imageHeight: number): [number, number] {
  const w = Math.max(1, Math.trunc(imageWidth));
  const h = Math.max(1, Math.trunc(imageHeight));
  const long = BRUSH_RASTER_LONG_EDGE;
  const short = (a: number, b: number) => Math.min(long, Math.max(1, Math.floor((a * long) / b)));
  return w >= h ? [long, short(h, w)] : [short(w, h), long];
}

/** A fresh brush mask: no dabs, no digest, unresolved — the session
 *  registers the first stroke and stamps the id. */
export function defaultBrushMask(): BrushMask {
  return { kind: 'brush', dabs: [], digest: '', rasterId: 0 };
}

// ── Rasterizer (port of `raw_core::types::brush`) ────────────────────────────

const smoothstep = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

const isFiniteDab = (d: BrushDab): boolean =>
  Number.isFinite(d.center.x) &&
  Number.isFinite(d.center.y) &&
  Number.isFinite(d.radius) &&
  Number.isFinite(d.feather) &&
  Number.isFinite(d.weight);

/**
 * Stamp `dabs` onto a `width × height` R8 grid (row-major, `0` = weight 0,
 * `255` = weight 1) — the TypeScript twin of `raw_core::rasterize_brush`,
 * same texel-centre convention (`(dim − 1)` grid), same radial profile
 * (full strength inside `(1 − feather)` of the radius, smoothstep falloff
 * to the edge), same flow accumulation (`acc + (1 − acc) × v`, erase as
 * `acc × (1 − v)`). Radius is a fraction of the grid WIDTH and the stamp is
 * circular in pixel space. The spec pins the shared vectors both
 * implementations must reproduce.
 */
export function rasterizeBrushDabs(
  dabs: readonly BrushDab[],
  width: number,
  height: number,
): Uint8ClampedArray {
  const w = Math.max(0, Math.trunc(width));
  const h = Math.max(0, Math.trunc(height));
  const acc = new Float32Array(w * h);
  if (w === 0 || h === 0) return new Uint8ClampedArray(0);
  for (const dab of dabs) {
    const rPx = dab.radius * w;
    if (!isFiniteDab(dab) || rPx <= 0 || dab.weight <= 0) continue;
    const cx = dab.center.x * Math.max(0, w - 1);
    const cy = dab.center.y * Math.max(0, h - 1);
    const feather = Math.min(1, Math.max(0, dab.feather));
    const weight = Math.min(1, Math.max(0, dab.weight));
    const clampX = (v: number): number => Math.min(w - 1, Math.max(0, v));
    const clampY = (v: number): number => Math.min(h - 1, Math.max(0, v));
    const x0 = Math.floor(clampX(cx - rPx));
    const x1 = Math.ceil(clampX(cx + rPx));
    const y0 = Math.floor(clampY(cy - rPx));
    const y1 = Math.ceil(clampY(cy + rPx));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / rPx;
        // Same profile as the radial evaluator: smoothstep from the inner
        // radius to the edge, hard step when the feather is ~0.
        const profile =
          feather <= 1.1920929e-7
            ? d <= 1
              ? 1
              : 0
            : 1 - smoothstep((d - (1 - feather)) / feather);
        const v = profile * weight;
        if (v <= 0) continue;
        const i = y * w + x;
        acc[i] = dab.erase ? acc[i] * (1 - v) : acc[i] + (1 - acc[i]) * v;
      }
    }
  }
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < acc.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, acc[i])) * 255);
  return out;
}

// ── Stroke capture ──────────────────────────────────────────────────────────

export interface DabStampOptions {
  radius: number;
  feather: number;
  weight: number;
  erase: boolean;
}

/**
 * The dab centres a pointer segment lays down, spaced `DAB_SPACING ×
 * radius` apart so the stroke is unbroken at any drag speed. `aspect` is the
 * image w/h — normalized units are not isotropic, so the segment length is
 * measured in width-fractions. Always stamps at least `to` (a tap is one
 * dab); never re-stamps `from` (the previous segment already did).
 */
export function interpolateDabs(
  from: MaskPoint,
  to: MaskPoint,
  aspect: number,
  opts: DabStampOptions,
): BrushDab[] {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const dx = to.x - from.x;
  const dy = (to.y - from.y) / safeAspect;
  const spacing = Math.max(opts.radius * DAB_SPACING, 1e-9);
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing));
  return Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    return {
      center: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
      radius: opts.radius,
      feather: opts.feather,
      weight: opts.weight,
      erase: opts.erase,
    };
  });
}

/** Pointer-pressure response: `0` (no sensor) reads as full pressure. */
export function applyPressure(
  radius: number,
  weight: number,
  pressure: number,
): { radius: number; weight: number } {
  const p = pressure > 0 ? Math.min(1, pressure) : 1;
  return {
    radius: radius * (PRESSURE_RADIUS_FLOOR + (1 - PRESSURE_RADIUS_FLOOR) * p),
    weight: weight * (PRESSURE_WEIGHT_FLOOR + (1 - PRESSURE_WEIGHT_FLOOR) * p),
  };
}

/** Stroke stabilizer: an exponential moving average over the raw pointer
 *  points. One instance per stroke — `reset` on pointer-down, `next` per
 *  move. */
export class StrokeSmoother {
  private point: MaskPoint | null = null;

  reset(p: MaskPoint): MaskPoint {
    this.point = { ...p };
    return p;
  }

  next(p: MaskPoint): MaskPoint {
    const s = this.point ?? p;
    const q = {
      x: s.x + (p.x - s.x) * STROKE_SMOOTHING_ALPHA,
      y: s.y + (p.y - s.y) * STROKE_SMOOTHING_ALPHA,
    };
    this.point = q;
    return q;
  }
}

/**
 * Re-express dabs in crop-normalized space for the tint: the overlay stamps
 * into a crop-sized buffer, so centres map through the full→crop affine and
 * radii scale by the width ratio. Exact for axis-aligned crops; under a
 * straighten rotation the radius scale is uniform while the true map is
 * not — invisible at tint resolution.
 */
export function mapDabsToCrop(
  dabs: readonly BrushDab[],
  fullToCrop: MaskAffine,
  radiusScale: number,
): BrushDab[] {
  return dabs.map((d) => ({
    ...d,
    center: applyAffine(fullToCrop, d.center),
    radius: d.radius * radiusScale,
  }));
}

/** `f32`s per dab on the `register-brush-raster` wire — `x, y, radius,
 *  feather, weight, erase`, the same field order as the `crs:Dabs` XMP series
 *  and the C ABI. */
export const BRUSH_DAB_STRIDE = 6;

/**
 * Flatten a dab series onto the `register-brush-raster` wire. A non-finite
 * dab would make the worker reject the WHOLE upload, so each dab is
 * sanitized first — and a dab that sanitizes to nothing (non-finite centre,
 * non-positive radius) is dropped rather than shifting its neighbours.
 */
export function flattenBrushDabs(dabs: readonly BrushDab[]): Float32Array {
  const out = new Float32Array(dabs.length * BRUSH_DAB_STRIDE);
  let n = 0;
  for (const d of dabs) {
    if (
      !Number.isFinite(d.center.x) ||
      !Number.isFinite(d.center.y) ||
      !Number.isFinite(d.radius) ||
      d.radius <= 0
    )
      continue;
    const base = n * BRUSH_DAB_STRIDE;
    out[base] = d.center.x;
    out[base + 1] = d.center.y;
    out[base + 2] = d.radius;
    out[base + 3] = Number.isFinite(d.feather) ? Math.min(1, Math.max(0, d.feather)) : 0;
    out[base + 4] = Number.isFinite(d.weight) ? Math.min(1, Math.max(0, d.weight)) : 0;
    out[base + 5] = d.erase ? 1 : 0;
    n++;
  }
  return out.subarray(0, n * BRUSH_DAB_STRIDE);
}

/**
 * The 16-lowercase-hex digest naming a brush raster — FNV-1a over the dab
 * payload, the same shape (not the same value: the payload serialization is
 * host-local) as Apple's `maskDigest`. Stable for identical strokes, so a
 * re-parse finds the already-registered raster instead of re-registering.
 */
export function brushDigest(dabs: readonly BrushDab[]): string {
  const payload = dabs
    .map((d) => [d.center.x, d.center.y, d.radius, d.feather, d.weight, d.erase ? 1 : 0].join(','))
    .join(';');
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < payload.length; i++) {
    h ^= BigInt(payload.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}
