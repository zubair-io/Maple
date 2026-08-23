// MuiHistogram — the Maple UI design-system Histogram data plot
// (unified-component-catalog.md §2.6; a plot primitive — draws directly via
// the Canvas 2D API, no external chart library). R/G/B channel colors are
// literal, not theme tokens — same "content-functional, not chrome color"
// precedent as mui-qr-code's hardcoded black/white: a histogram's
// red/green/blue bars ARE the channel identity, independent of the app's
// accent color.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  viewChild,
} from '@angular/core';
import { beginPlotDraw, drawVerticalBars, rgbChannels } from '../internal/plot-canvas';

const CHANNEL_COLOR = {
  r: 'rgba(220, 80, 80, 0.6)',
  g: 'rgba(80, 190, 80, 0.6)',
  b: 'rgba(80, 130, 220, 0.6)',
} as const;

@Component({
  selector: 'mui-histogram',
  standalone: true,
  templateUrl: './mui-histogram.component.html',
  styleUrl: './mui-histogram.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiHistogramComponent {
  /** Per-bin counts, one entry per channel — any bin count works, the plot
   * scales bar width to fit. */
  readonly r = input.required<readonly number[]>();
  readonly g = input.required<readonly number[]>();
  readonly b = input.required<readonly number[]>();
  readonly width = input<number>(240);
  readonly height = input<number>(64);

  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  constructor() {
    effect(() => {
      this.r();
      this.g();
      this.b();
      this.width();
      this.height();
      this.draw();
    });
  }

  private draw(): void {
    const w = this.width();
    const h = this.height();
    const frame = beginPlotDraw(this.canvas(), w, h);
    if (!frame) return;
    const { ctx } = frame;

    const channels = rgbChannels(this.r(), this.g(), this.b(), CHANNEL_COLOR);

    let peak = 1;
    for (const { values } of channels) {
      for (const value of values) peak = Math.max(peak, value);
    }

    for (const { values, color } of channels) {
      drawVerticalBars(ctx, values, color, 0, w, h, (value) => value / peak);
    }
  }
}
