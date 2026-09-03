// Shared Canvas 2D helpers for the Maple UI "data plot" molecules (histogram,
// parade, waveform, heatmap-layer, vectorscope, connection-graph, curve-plot
// — unified-component-catalog.md §2.6). Not part of the public API surface
// (see ../public-api.ts) — these are implementation details the plots share,
// not a component contract of their own.

import { Directive, type ElementRef, afterRenderEffect, input, viewChild } from '@angular/core';

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

/** Registers a render-phase effect (`afterRenderEffect`) that reads each of
 * `deps` (establishing them as dependencies) and then calls `draw` — the
 * shared "redraw whenever any input/size/color signal changes" constructor
 * wiring every plot molecule's `draw()`-on-effect pattern otherwise repeats
 * verbatim (connection-graph, curve-plot, heatmap-layer, histogram, parade,
 * waveform, vectorscope). Must be called synchronously from a constructor
 * (or another injection context).
 *
 * `afterRenderEffect`, not `effect()` (#2449): a plain effect runs BEFORE
 * the component's template bindings are applied, so a plot mounted with
 * its sample already present (a re-opened scopes panel) painted onto the
 * canvas first and then had its bitmap wiped when the `[attr.width]` /
 * `[attr.height]` bindings landed — the first mount only looked right
 * because the live frame arrived later and re-triggered the draw. Drawing
 * after render puts the paint after the size bindings on every mount. */
export function watchAndDraw(deps: readonly (() => unknown)[], draw: () => void): void {
  afterRenderEffect(() => {
    deps.forEach((dep) => dep());
    draw();
  });
}

/** {@link beginPlotDraw} convenience for the common case where the frame's
 * pixel size comes from separate `width()`/`height()` signals: reads both
 * once, begins the frame, and returns them alongside `canvasEl`/`ctx` so a
 * `draw()` that needs `w`/`h` later doesn't re-read the signals — the
 * shared `draw()` prologue every plot molecule sized by `width`/`height`
 * (rather than a single `size`, like vectorscope) otherwise repeats
 * verbatim. */
export function beginSizedPlotDraw(
  canvasRef: ElementRef<HTMLCanvasElement> | undefined,
  width: () => number,
  height: () => number,
): (PlotFrame & { readonly w: number; readonly h: number }) | null {
  const w = width();
  const h = height();
  const frame = beginPlotDraw(canvasRef, w, h);
  return frame ? { ...frame, w, h } : null;
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

/** The full inputs/viewChild/redraw-wiring/draw-prologue shared by Histogram
 * and Parade — both are "three RGB channel value arrays, rasterized as
 * vertical bar lanes," differing only in how a channel's values map to bar
 * heights and how lanes are laid out (see {@link drawVerticalBars}'s doc
 * comment). An `@Directive()` abstract base (Angular's supported pattern
 * for sharing component behavior without a template — same shape as
 * `DestructiveConfirmDialogBase`/`MediaTransportBase`), not a fourth
 * `watchAndDraw`/`beginSizedPlotDraw` call site: the field declarations,
 * constructor, and `draw()` prologue were already byte-identical. Each
 * subclass supplies its own literal `channelColor` (histogram vs. parade
 * alpha) and `drawChannels` (the lane layout). */
@Directive()
export abstract class RgbChannelPlotBase {
  readonly r = input.required<readonly number[]>();
  readonly g = input.required<readonly number[]>();
  readonly b = input.required<readonly number[]>();
  readonly width = input<number>(240);
  readonly height = input<number>(64);

  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  protected abstract readonly channelColor: {
    readonly r: string;
    readonly g: string;
    readonly b: string;
  };

  constructor() {
    watchAndDraw([this.r, this.g, this.b, this.width, this.height], () => this.draw());
  }

  /** Lays out the three channels within the frame — histogram scales bars
   * peak-relative with no lane gap; parade clamps 0..1 per lane with a gap
   * between lanes. */
  protected abstract drawChannels(
    ctx: CanvasRenderingContext2D,
    channels: readonly RgbChannel[],
    w: number,
    h: number,
  ): void;

  private draw(): void {
    const frame = beginSizedPlotDraw(this.canvas(), this.width, this.height);
    if (!frame) return;
    const { ctx, w, h } = frame;
    this.drawChannels(ctx, rgbChannels(this.r(), this.g(), this.b(), this.channelColor), w, h);
  }
}

/** The `canvas` viewChild + redraw-wiring + `draw()`-prologue shared by
 * every plot molecule sized by separate `width`/`height` signals
 * (connection-graph, curve-plot, heatmap-layer, waveform — histogram/parade
 * have their own, more specific `RgbChannelPlotBase`). `width`/`height`
 * themselves stay on each subclass (their defaults genuinely differ per
 * plot — 160×96 vs. 240×64 — so they can't live on a shared base with one
 * fixed default), which means the redraw wiring can't auto-run from this
 * base's own constructor the way `RgbChannelPlotBase`'s does: a base
 * constructor runs before a subclass's own field initializers, so it can't
 * yet read a subclass-declared `input()`. Each subclass instead calls
 * {@link watchRedraw} itself, from its own constructor, once its own inputs
 * are live — same "@Directive() abstract base sharing behavior without a
 * template" pattern as `RgbChannelPlotBase`, just with construction-order
 * pushed one step later. */
@Directive()
export abstract class SizedCanvasPlotBase {
  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  protected abstract width(): number;
  protected abstract height(): number;

  /** Call once, from the subclass's own constructor, with every signal the
   * redraw should depend on (typically the subclass's own value/size/color
   * inputs). */
  protected watchRedraw(deps: readonly (() => unknown)[]): void {
    watchAndDraw(deps, () => this.draw());
  }

  /** The subclass's actual per-frame rendering, given the already-cleared
   * frame + its current pixel size. Not called at all when there's nothing
   * to draw into yet (e.g. before the first view-init pass). */
  protected abstract renderFrame(frame: PlotFrame, w: number, h: number): void;

  private draw(): void {
    const frame = beginSizedPlotDraw(
      this.canvas(),
      () => this.width(),
      () => this.height(),
    );
    if (frame) this.renderFrame(frame, frame.w, frame.h);
  }
}
