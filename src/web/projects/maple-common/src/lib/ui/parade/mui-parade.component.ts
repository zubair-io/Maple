// MuiParade — the Maple UI design-system Parade data plot
// (unified-component-catalog.md §2.6; a plot primitive). Three
// side-by-side per-channel waveforms. Like Histogram, the R/G/B colors are
// literal channel identity, not theme tokens (mui-qr-code precedent).

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  viewChild,
} from '@angular/core';
import { beginPlotDraw, clampUnit, drawVerticalBars, rgbChannels } from '../internal/plot-canvas';

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
  styleUrl: './mui-parade.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiParadeComponent {
  /** Per-column samples, 0..1, one array per channel. */
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

    const laneWidth = (w - GAP_PX * (channels.length - 1)) / channels.length;
    channels.forEach((channel, laneIndex) => {
      const laneX = laneIndex * (laneWidth + GAP_PX);
      drawVerticalBars(ctx, channel.values, channel.color, laneX, laneWidth, h, clampUnit);
    });
  }
}
