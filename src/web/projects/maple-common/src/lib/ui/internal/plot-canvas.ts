// Shared Canvas 2D helpers for the Maple UI "data plot" molecules (histogram,
// parade, waveform, heatmap-layer, vectorscope, connection-graph, curve-plot
// — unified-component-catalog.md §2.6). Not part of the public API surface
// (see ../public-api.ts) — these are implementation details the plots share,
// not a component contract of their own.

import type { ElementRef } from '@angular/core';

/** Resolves a `var(--token)` reference against the element's computed
 * style; passes any other string (already a literal color) through as-is. */
export function resolveColor(el: HTMLElement, colorOrVar: string): string {
  if (!colorOrVar.startsWith('var(')) return colorOrVar;
  const varName = colorOrVar.slice(4, -1).split(',')[0].trim();
  const resolved = getComputedStyle(el).getPropertyValue(varName).trim();
  return resolved || colorOrVar;
}

/** The element + context pair every plot's `draw()` renders into, once
 * {@link beginPlotDraw} confirms both are available. */
export interface PlotFrame {
  readonly canvasEl: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
}

/** Common `draw()` prologue shared by every canvas-backed plot: resolves the
 * view-child canvas ref to its element + 2D context (`null` if either isn't
 * available yet — e.g. before the first view-init pass) and clears the
 * frame to the plot's current size. Returns `null` when there's nothing to
 * draw into, so callers can early-return with a single check. */
export function beginPlotDraw(
  canvasRef: ElementRef<HTMLCanvasElement> | undefined,
  width: number,
  height: number,
): PlotFrame | null {
  const canvasEl = canvasRef?.nativeElement;
  if (!canvasEl) return null;
  const ctx = canvasEl.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);
  return { canvasEl, ctx };
}

/** Clamps a sample to the `[0, 1]` plot-value range. */
export function clampUnit(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** One RGB channel's values + the literal color it draws in. */
export interface RgbChannel {
  readonly values: readonly number[];
  readonly color: string;
}

/** Pairs each of the three RGB channels' value arrays with its literal
 * channel color — the per-`draw()` setup shared by Histogram (per-bin
 * counts) and Parade (per-column samples), which otherwise scale and lay
 * out those values differently. */
export function rgbChannels(
  r: readonly number[],
  g: readonly number[],
  b: readonly number[],
  color: { readonly r: string; readonly g: string; readonly b: string },
): readonly RgbChannel[] {
  return [
    { values: r, color: color.r },
    { values: g, color: color.g },
    { values: b, color: color.b },
  ];
}

/** Draws one lane/channel of a vertical bar plot (histogram, parade): each
 * value is mapped to a `[0, 1]` bar-height fraction via `valueToUnit`, then
 * rendered as a fixed-width column filling `laneWidth` px starting at
 * `originX`. Shared by Histogram (peak-relative scaling, no lane gap) and
 * Parade (per-lane 0..1 clamp, gapped lanes) — the scaling and layout stay
 * with each caller, only the bar-rasterizing loop is common. */
export function drawVerticalBars(
  ctx: CanvasRenderingContext2D,
  values: readonly number[],
  color: string,
  originX: number,
  laneWidth: number,
  height: number,
  valueToUnit: (value: number) => number,
): void {
  if (values.length === 0) return;
  ctx.fillStyle = color;
  const colWidth = laneWidth / values.length;
  for (let i = 0; i < values.length; i++) {
    const barHeight = valueToUnit(values[i]) * (height - 2);
    ctx.fillRect(
      originX + i * colWidth,
      height - barHeight,
      Math.max(1, colWidth - 0.5),
      barHeight,
    );
  }
}
