// MuiVectorscope — the Maple UI design-system Vectorscope data plot
// (unified-component-catalog.md §2.6; a plot primitive). A chroma scatter
// plot (or, since #3276, a density heatmap) on a circular graticule: the
// broadcast target markers (R/Mg/B/Cy/G/Yl) and an optional skin-tone line
// always draw against the Rec.709 chroma space raw-core's GPU/CPU scope
// pass uses — a DIFFERENT quantity from the legacy per-sample dot-scatter's
// BT.601 chroma (`chromaBt601`), kept side by side rather than replaced so
// existing scatter call sites don't silently shift colour space. Chrome
// (circle, spokes) uses the border token; dots use the accent token — both
// resolved from `--color-*` via `getComputedStyle` at draw time (see
// mui-waveform's `resolveColor`).

import { ChangeDetectionStrategy, Component, ElementRef, input, viewChild } from '@angular/core';
import { beginPlotDraw, resolveColor, watchAndDraw } from '../internal/plot-canvas';

export interface MuiVectorscopeSample {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** The six broadcast-graticule primary/secondary targets a vectorscope
 * plots, in the ACTUAL counter-clockwise order the Rec.709 matrix puts them
 * in (verified against `chromaRec709` of each pure colour — NOT a uniform
 * 60°-per-step wheel; real vectorscope targets alternate between roughly
 * 54° and 72° gaps, a well-known property of how the eye's hue sensitivity
 * is baked into these coefficients, not a bug). */
export const VECTORSCOPE_TARGETS = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as const;
export type VectorscopeTarget = (typeof VECTORSCOPE_TARGETS)[number];

export const TARGET_RGB: Record<VectorscopeTarget, readonly [number, number, number]> = {
  red: [1, 0, 0],
  yellow: [1, 1, 0],
  green: [0, 1, 0],
  cyan: [0, 1, 1],
  blue: [0, 0, 1],
  magenta: [1, 0, 1],
};

/** BT.601 luma-independent chroma pair for an RGB sample — the legacy
 * per-sample scatter path's colour space. */
export function chromaBt601(r: number, g: number, b: number): { cb: number; cr: number } {
  return {
    cb: -0.168736 * r - 0.331264 * g + 0.5 * b,
    cr: 0.5 * r - 0.418688 * g - 0.081312 * b,
  };
}

/** Rec.709 luma-independent chroma — matches raw-core's
 * `scope::vectorscope::cb_cr_rec709` exactly (spec §11: display-referred
 * Rec.709, the GPU/CPU scope pass's own space). */
export function chromaRec709(r: number, g: number, b: number): { cb: number; cr: number } {
  return {
    cb: -0.114572 * r - 0.385428 * g + 0.5 * b,
    cr: 0.5 * r - 0.454153 * g - 0.045847 * b,
  };
}

/** The broadcast graticule angle (degrees, 0° = +cb axis, CCW) of each
 * primary/secondary target — derived from `chromaRec709` of the pure
 * colour itself, so the six dots can never drift from the plotted math. */
export function targetAngleDeg(target: VectorscopeTarget): number {
  const [r, g, b] = TARGET_RGB[target];
  const { cb, cr } = chromaRec709(r, g, b);
  return (Math.atan2(cr, cb) * 180) / Math.PI;
}

/** Chroma-space centre of bin `(row, col)` of an `n x n` grid over the
 *  [-0.5, 0.5] square. Row 0 is the top (most positive cr). */
export function binCentre(
  row: number,
  col: number,
  n: number,
): { readonly cb: number; readonly cr: number } {
  return { cb: (col + 0.5) / n - 0.5, cr: 0.5 - (row + 0.5) / n };
}

/** Rotate a chroma pair by `degrees` counter-clockwise about the origin. */
export function rotated(cb: number, cr: number, degrees: number): { cb: number; cr: number } {
  const rad = (degrees * Math.PI) / 180;
  return {
    cb: cb * Math.cos(rad) - cr * Math.sin(rad),
    cr: cb * Math.sin(rad) + cr * Math.cos(rad),
  };
}

/** `angle` folded into `0..<360`. */
export function normalizedDeg(angle: number): number {
  const m = angle % 360;
  return m < 0 ? m + 360 : m;
}

/** The hue-ring colour at a graticule angle, interpolated between the two
 * bracketing broadcast targets in their TRUE (non-uniform) angular
 * positions — so the ring's colours line up with the six target dots
 * exactly rather than drifting against them. Interpolating on a uniform 60°
 * hexagon instead would put, say, pure yellow several degrees off its own
 * marker; the targets alternate ~54°/72° gaps and the ring has to follow
 * that. Mirrors Apple's `MuiVectorscopeMath.ringRGB`. */
export function ringRGB(angleDeg: number): [number, number, number] {
  const stops = VECTORSCOPE_TARGETS.map((t) => ({
    angle: normalizedDeg(targetAngleDeg(t)),
    rgb: TARGET_RGB[t],
  })).sort((a, b) => a.angle - b.angle);
  const a = normalizedDeg(angleDeg);
  const upperIndex = stops.findIndex((s) => s.angle >= a);
  const upper = stops[upperIndex === -1 ? 0 : upperIndex];
  const lower = stops[((upperIndex === -1 ? 0 : upperIndex) + stops.length - 1) % stops.length];
  const span = normalizedDeg(upper.angle - lower.angle);
  if (span <= 0) return [lower.rgb[0], lower.rgb[1], lower.rgb[2]];
  const t = normalizedDeg(a - lower.angle) / span;
  return [
    lower.rgb[0] + (upper.rgb[0] - lower.rgb[0]) * t,
    lower.rgb[1] + (upper.rgb[1] - lower.rgb[1]) * t,
    lower.rgb[2] + (upper.rgb[2] - lower.rgb[2]) * t,
  ];
}

/** Broadcast-convention skin-tone line angle (spec §11 — a graticule
 * constant, independent of the core's Oklab `skinTone` range preset hue). */
export const SKIN_TONE_LINE_ANGLE_DEG = 123.0;
export const SKIN_TONE_LINE_WEDGE_DEG = 10.0;

@Component({
  selector: 'mui-vectorscope',
  standalone: true,
  templateUrl: './mui-vectorscope.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiVectorscopeComponent {
  /** RGB samples, each channel 0..1. */
  readonly samples = input.required<readonly MuiVectorscopeSample[]>();
  readonly size = input<number>(64);
  readonly dotColor = input<string>('var(--color-primary)');
  /** Row-major density bins (spec §3.1's HUD path), `n × n` for any `n`.
   * `undefined` keeps the legacy per-sample dot-scatter draw. */
  readonly bins = input<readonly (readonly number[])[] | undefined>(undefined);
  /** Draws the broadcast skin-tone line + wedge graticule overlay. */
  readonly showSkinToneLine = input<boolean>(false);
  /** Rotates the whole plot so the Red target sits at 0° (3 o'clock)
   * instead of its native ~103°. */
  readonly redAt3OClock = input<boolean>(false);

  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  constructor() {
    // `watchAndDraw` (afterRenderEffect), NOT a plain `effect()` (#2449):
    // an effect runs BEFORE the template's `[attr.width]`/`[attr.height]`
    // bindings are applied, and writing a canvas's size resets its bitmap —
    // so drawing from an effect paints and is then immediately wiped. The
    // dependency list is #3276's full set.
    watchAndDraw(
      [this.samples, this.size, this.dotColor, this.bins, this.showSkinToneLine, this.redAt3OClock],
      () => this.draw(),
    );
  }

  private rotationDeg(): number {
    return this.redAt3OClock() ? -targetAngleDeg('red') : 0;
  }

  private draw(): void {
    const size = this.size();
    const frame = beginPlotDraw(this.canvas(), size, size);
    if (!frame) return;
    const { canvasEl, ctx } = frame;

    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 4;
    const rotationDeg = this.rotationDeg();

    this.drawHueRing(ctx, cx, cy, radius, rotationDeg);

    // Spokes are dashed so they read as a measurement graticule rather than
    // as plotted data — at HUD size a solid spoke and a thin chroma trace
    // are the same handful of pixels.
    ctx.strokeStyle = resolveColor(canvasEl, 'var(--color-border)');
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 3]);
    for (const target of VECTORSCOPE_TARGETS) {
      const angle = ((targetAngleDeg(target) + rotationDeg) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * radius, cy - Math.sin(angle) * radius);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Target dots sit ON the hue ring, each in its own colour — the ring
    // says "this direction is this hue" and the dot says "this exact angle
    // is the broadcast target for it".
    for (const target of VECTORSCOPE_TARGETS) {
      const angle = ((targetAngleDeg(target) + rotationDeg) * Math.PI) / 180;
      const px = cx + Math.cos(angle) * radius;
      const py = cy - Math.sin(angle) * radius;
      const [r, g, b] = TARGET_RGB[target];
      ctx.fillStyle = `rgb(${r * 255}, ${g * 255}, ${b * 255})`;
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (this.showSkinToneLine()) {
      this.drawSkinToneLine(ctx, cx, cy, radius, rotationDeg);
    }

    const bins = this.bins();
    if (bins) {
      this.drawDensity(ctx, bins, cx, cy, radius, rotationDeg);
    } else {
      ctx.fillStyle = resolveColor(canvasEl, this.dotColor());
      for (const sample of this.samples()) {
        const { cb, cr } = chromaBt601(sample.r, sample.g, sample.b);
        const x = cx + cb * radius * 2;
        const y = cy - cr * radius * 2;
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawSkinToneLine(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    rotationDeg: number,
  ): void {
    const centreAngle = SKIN_TONE_LINE_ANGLE_DEG + rotationDeg;
    const wedge = SKIN_TONE_LINE_WEDGE_DEG;
    const lo = ((centreAngle - wedge) * Math.PI) / 180;
    const hi = ((centreAngle + wedge) * Math.PI) / 180;

    // Filled cone rather than two bare edge lines: the band is the thing
    // being read — the user drags Hue until the chroma cloud sits inside
    // it, and a filled region shows in/out at a glance where two hairlines
    // did not. Mirrors Apple's `drawSkinToneLine`.
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(lo) * radius, cy - Math.sin(lo) * radius);
    ctx.lineTo(cx + Math.cos(hi) * radius, cy - Math.sin(hi) * radius);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.30)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 1;
    const rad = (centreAngle * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad) * radius, cy - Math.sin(rad) * radius);
    ctx.stroke();

    // Person marker at the skin-tone angle — the legend for the cone, so
    // the band needs no separate caption. Drawn as a head + shoulders arc
    // rather than an icon font: the canvas has no SF Symbols, and a glyph
    // dependency for one 10px mark is not worth it.
    const box = Math.max(9, radius * 0.2);
    const inset = radius - box * 0.75;
    const mx = cx + Math.cos(rad) * inset;
    const my = cy - Math.sin(rad) * inset;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = Math.max(1, box * 0.11);
    ctx.beginPath();
    ctx.arc(mx, my - box * 0.18, box * 0.18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(mx, my + box * 0.34, box * 0.32, Math.PI, 0);
    ctx.stroke();
  }

  /** The continuous hue ring around the rim. Drawn as short arc segments
   * rather than a CSS conic gradient so the colour at every angle comes
   * from the SAME Rec.709 target math the dots and the plotted chroma use —
   * a gradient would interpolate over a uniform hexagon and drift against
   * the real, non-uniformly spaced targets. Mirrors Apple's `drawHueRing`. */
  private drawHueRing(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    rotationDeg: number,
  ): void {
    const step = 2;
    ctx.lineWidth = Math.max(2, radius * 0.06);
    ctx.setLineDash([]);
    for (let a = 0; a < 360; a += step) {
      const [r, g, b] = ringRGB(a);
      ctx.strokeStyle = `rgb(${r * 255}, ${g * 255}, ${b * 255})`;
      ctx.beginPath();
      // Canvas y grows down while graticule angles grow counter-clockwise,
      // so the sweep is negated to match the dots.
      ctx.arc(
        cx,
        cy,
        radius,
        (-(a + rotationDeg) * Math.PI) / 180,
        (-(a + step + rotationDeg) * Math.PI) / 180,
        true,
      );
      ctx.stroke();
    }
  }

  /** Density cells are drawn in log-scaled opacity (`log(1+count) /
   * log(1+max)`) rather than linear, so a single dominant bin (the grey
   * axis on most real photos) doesn't crush every other bin down to
   * invisible. Mirrors Apple's `MuiVectorscope.drawDensity` line for line. */
  /** Largest bin count, or 0 when the grid is empty — the log scale's
   *  denominator. Split out of `drawDensity` to keep that method within the
   *  complexity budget the web fallow audit enforces. */
  private static peakBin(bins: readonly (readonly number[])[]): number {
    let peak = 0;
    for (const row of bins) {
      for (const v of row) {
        if (v > peak) peak = v;
      }
    }
    return peak;
  }

  /** Canvas point for bin `(row, col)` of an `n x n` grid over the same
   *  [-0.5, 0.5] chroma square the scatter path maps. Row 0 is the
   *  most-positive cr (cr grows UP on screen), hence `0.5 - row / n`. */
  private static binPoint(
    row: number,
    col: number,
    n: number,
    cx: number,
    cy: number,
    radius: number,
    rotationDeg: number,
  ): { readonly x: number; readonly y: number } {
    // Bin CENTRES (not top-left corners): a cell drawn `cell / 2` either
    // side of the point then tiles the square exactly (#3292 review).
    let { cb, cr } = binCentre(row, col, n);
    if (rotationDeg !== 0) {
      ({ cb, cr } = rotated(cb, cr, rotationDeg));
    }
    return { x: cx + cb * radius * 2, y: cy - cr * radius * 2 };
  }

  private drawDensity(
    ctx: CanvasRenderingContext2D,
    bins: readonly (readonly number[])[],
    cx: number,
    cy: number,
    radius: number,
    rotationDeg: number,
  ): void {
    const n = bins.length;
    const peak = MuiVectorscopeComponent.peakBin(bins);
    if (n === 0 || peak <= 0) return;
    const cell = (radius * 2) / n;
    const baseColor = resolveColor(this.canvas()!.nativeElement, this.dotColor());
    const logPeak = Math.log(1 + peak);
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const count = bins[row]?.[col];
        // `!(count > 0)` also skips `undefined` from a ragged row, which
        // `count <= 0` would let through into the log scale as NaN.
        if (!(count > 0)) continue;
        const t = Math.log(1 + count) / logPeak;
        const { x, y } = MuiVectorscopeComponent.binPoint(row, col, n, cx, cy, radius, rotationDeg);
        ctx.fillStyle = withOpacity(baseColor, 0.15 + 0.85 * t);
        ctx.fillRect(x - cell / 2, y - cell / 2, cell, cell);
      }
    }
  }
}

/** Applies an opacity fraction to a resolved CSS color by wrapping it in
 * `color-mix()` — works for any resolved color syntax (`#rrggbb`, `rgb()`,
 * a named color) without parsing it, since `resolveColor` may hand back any
 * of those depending on what the token/computed-style resolves to. */
function withOpacity(color: string, opacity: number): string {
  const pct = Math.round(Math.max(0, Math.min(1, opacity)) * 100);
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}
