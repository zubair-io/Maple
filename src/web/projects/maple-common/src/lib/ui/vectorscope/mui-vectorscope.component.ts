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

const TARGET_RGB: Record<VectorscopeTarget, readonly [number, number, number]> = {
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

/** Rotate a chroma pair by `degrees` counter-clockwise about the origin. */
export function rotated(cb: number, cr: number, degrees: number): { cb: number; cr: number } {
  const rad = (degrees * Math.PI) / 180;
  return {
    cb: cb * Math.cos(rad) - cr * Math.sin(rad),
    cr: cb * Math.sin(rad) + cr * Math.cos(rad),
  };
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
      [
        this.samples,
        this.size,
        this.dotColor,
        this.bins,
        this.showSkinToneLine,
        this.redAt3OClock,
      ],
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

    const chromeColor = resolveColor(canvasEl, 'var(--color-border)');
    ctx.strokeStyle = chromeColor;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      ctx.stroke();
    }

    const targetColor = resolveColor(canvasEl, 'var(--color-text-muted)');
    ctx.fillStyle = targetColor;
    for (const target of VECTORSCOPE_TARGETS) {
      const angle = ((targetAngleDeg(target) + rotationDeg) * Math.PI) / 180;
      const px = cx + Math.cos(angle) * radius * 0.82;
      const py = cy - Math.sin(angle) * radius * 0.82;
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
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

    ctx.strokeStyle = 'rgba(234, 179, 8, 0.25)'; // yellow, 25% — matches Apple's .yellow.opacity(0.25)
    ctx.lineWidth = 1;
    for (const a of [centreAngle - wedge, centreAngle + wedge]) {
      const rad = (a * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(rad) * radius, cy - Math.sin(rad) * radius);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(234, 179, 8, 0.7)'; // yellow, 70% — matches Apple's .yellow.opacity(0.7)
    const rad = (centreAngle * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad) * radius, cy - Math.sin(rad) * radius);
    ctx.stroke();
  }

  /** Density cells are drawn in log-scaled opacity (`log(1+count) /
   * log(1+max)`) rather than linear, so a single dominant bin (the grey
   * axis on most real photos) doesn't crush every other bin down to
   * invisible. Mirrors Apple's `MuiVectorscope.drawDensity` line for line. */
  private drawDensity(
    ctx: CanvasRenderingContext2D,
    bins: readonly (readonly number[])[],
    cx: number,
    cy: number,
    radius: number,
    rotationDeg: number,
  ): void {
    const n = bins.length;
    if (n === 0) return;
    let maxCount = 0;
    for (const row of bins) {
      for (const v of row) {
        if (v > maxCount) maxCount = v;
      }
    }
    if (maxCount <= 0) return;
    const cell = (radius * 2) / n;
    const baseColor = resolveColor(this.canvas()!.nativeElement, this.dotColor());
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const count = bins[row][col];
        if (count <= 0) continue;
        const t = Math.log(1 + count) / Math.log(1 + maxCount);
        // Bin (row, col) covers an n×n grid over the SAME [-0.5, 0.5]
        // chroma square the scatter path maps — row 0 is the most-positive
        // cr (cr grows UP on screen, so the top row is HIGH cr, hence
        // `0.5 - row/n`).
        let cb = col / n - 0.5;
        let cr = 0.5 - row / n;
        if (rotationDeg !== 0) {
          ({ cb, cr } = rotated(cb, cr, rotationDeg));
        }
        const x = cx + cb * radius * 2;
        const y = cy - cr * radius * 2;
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
