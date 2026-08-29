// MuiHeatmapLayer — the Maple UI design-system Heatmap Layer data plot
// (unified-component-catalog.md §2.6; a plot primitive). A density grid
// rendered as an alpha-blended overlay canvas (e.g. a face-detection density
// map synced to a map/photo viewport camera elsewhere in the app — the
// camera-sync itself is the host's concern; this component only rasterizes
// the grid it's given). Cell color reads the accent token, alpha-blended per
// cell by that cell's normalized density.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SizedCanvasPlotBase, resolveColor } from '../internal/plot-canvas';
import type { PlotFrame } from '../internal/plot-canvas';

@Component({
  selector: 'mui-heatmap-layer',
  standalone: true,
  templateUrl: './mui-heatmap-layer.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class MuiHeatmapLayerComponent extends SizedCanvasPlotBase {
  /** Rows of per-cell density, each 0..1. Every row must be the same
   * length; an empty grid draws nothing. */
  readonly grid = input.required<readonly (readonly number[])[]>();
  readonly width = input<number>(160);
  readonly height = input<number>(96);
  readonly color = input<string>('var(--color-primary)');

  constructor() {
    super();
    this.watchRedraw([this.grid, this.width, this.height, this.color]);
  }

  protected renderFrame({ canvasEl, ctx }: PlotFrame, w: number, h: number): void {
    const rows = this.grid();
    if (rows.length === 0 || rows[0].length === 0) return;

    const cols = rows[0].length;
    const cellW = w / cols;
    const cellH = h / rows.length;
    const rgb = hexToRgb(resolveColor(canvasEl, this.color()));

    rows.forEach((row, rowIndex) => {
      row.forEach((value, colIndex) => {
        const density = Math.max(0, Math.min(1, value));
        if (density === 0) return;
        ctx.fillStyle = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${density})` : this.color();
        ctx.fillRect(colIndex * cellW, rowIndex * cellH, cellW, cellH);
      });
    });
  }
}

/** Parses a `#rgb`/`#rrggbb` hex color into components; returns `null` for
 * anything else (e.g. an unresolved `var(...)` string in a test
 * environment with no stylesheet loaded) so the caller can fall back to
 * using the string directly as `fillStyle`. */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (short) {
    return {
      r: Number.parseInt(short[1] + short[1], 16),
      g: Number.parseInt(short[2] + short[2], 16),
      b: Number.parseInt(short[3] + short[3], 16),
    };
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (long) {
    return {
      r: Number.parseInt(long[1], 16),
      g: Number.parseInt(long[2], 16),
      b: Number.parseInt(long[3], 16),
    };
  }
  return null;
}
