// MuiParade — the Maple UI design-system Parade data plot
// (unified-component-catalog.md §2.6; a plot primitive). Three
// side-by-side per-channel waveforms. Like Histogram, the R/G/B colors are
// literal channel identity, not theme tokens (mui-qr-code precedent).
// Per-column samples are expected 0..1, one array per channel.

import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RgbChannelPlotBase, clampUnit, drawVerticalBars } from '../internal/plot-canvas';
import type { RgbChannel } from '../internal/plot-canvas';

const CHANNEL_COLOR = {
  r: 'rgba(220, 80, 80, 0.85)',
  g: 'rgba(80, 190, 80, 0.85)',
  b: 'rgba(80, 130, 220, 0.85)',
} as const;

const GAP_PX = 4;

@Component({
  selector: 'mui-parade',
  standalone: true,
  templateUrl: './mui-parade.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiParadeComponent extends RgbChannelPlotBase {
  protected readonly channelColor = CHANNEL_COLOR;

  /** Per-lane 0..1 clamp, gapped lanes — each channel gets its own
   * side-by-side lane, unlike Histogram's shared/overlapping bars. */
  protected drawChannels(
    ctx: CanvasRenderingContext2D,
    channels: readonly RgbChannel[],
    w: number,
    h: number,
  ): void {
    const laneWidth = (w - GAP_PX * (channels.length - 1)) / channels.length;
    channels.forEach((channel, laneIndex) => {
      const laneX = laneIndex * (laneWidth + GAP_PX);
      drawVerticalBars(ctx, channel.values, channel.color, laneX, laneWidth, h, clampUnit);
    });
  }
}
