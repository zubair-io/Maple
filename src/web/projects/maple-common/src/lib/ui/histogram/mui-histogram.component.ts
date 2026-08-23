// MuiHistogram — the Maple UI design-system Histogram data plot
// (unified-component-catalog.md §2.6; a plot primitive — draws directly via
// the Canvas 2D API, no external chart library). R/G/B channel colors are
// literal, not theme tokens — same "content-functional, not chrome color"
// precedent as mui-qr-code's hardcoded black/white: a histogram's
// red/green/blue bars ARE the channel identity, independent of the app's
// accent color.

import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RgbChannelPlotBase, drawVerticalBars } from '../internal/plot-canvas';
import type { RgbChannel } from '../internal/plot-canvas';

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
export class MuiHistogramComponent extends RgbChannelPlotBase {
  protected readonly channelColor = CHANNEL_COLOR;

  /** Peak-relative scaling, no lane gap — every bin's bar height is
   * relative to the tallest bin across all three channels. */
  protected drawChannels(
    ctx: CanvasRenderingContext2D,
    channels: readonly RgbChannel[],
    w: number,
    h: number,
  ): void {
    let peak = 1;
    for (const { values } of channels) {
      for (const value of values) peak = Math.max(peak, value);
    }

    for (const { values, color } of channels) {
      drawVerticalBars(ctx, values, color, 0, w, h, (value) => value / peak);
    }
  }
}
