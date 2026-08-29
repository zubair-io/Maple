// MuiWaveform — the Maple UI design-system Waveform data plot
// (unified-component-catalog.md §2.6; a plot primitive). A single-channel
// luma column plot. Unlike Histogram/Parade's literal RGB channel colors,
// a luma waveform has no inherent color of its own, so it reads the app's
// accent token — resolved from the live `--color-*` custom property via
// `getComputedStyle` at draw time, since a raw `ctx.fillStyle = 'var(...)'`
// string is not resolved by the Canvas 2D API.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SizedCanvasPlotBase, resolveColor } from '../internal/plot-canvas';
import type { PlotFrame } from '../internal/plot-canvas';

@Component({
  selector: 'mui-waveform',
  standalone: true,
  templateUrl: './mui-waveform.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiWaveformComponent extends SizedCanvasPlotBase {
  /** Per-column luma samples, 0..1. */
  readonly luma = input.required<readonly number[]>();
  readonly width = input<number>(240);
  readonly height = input<number>(64);
  /** A literal color, or a `var(--token)` reference resolved at draw time. */
  readonly color = input<string>('var(--color-primary)');

  constructor() {
    super();
    this.watchRedraw([this.luma, this.width, this.height, this.color]);
  }

  protected renderFrame({ canvasEl, ctx }: PlotFrame, w: number, h: number): void {
    const samples = this.luma();
    if (samples.length === 0) return;

    ctx.fillStyle = resolveColor(canvasEl, this.color());
    const colWidth = w / samples.length;
    for (let i = 0; i < samples.length; i++) {
      const barHeight = Math.max(0, Math.min(1, samples[i])) * (h - 2);
      ctx.fillRect(i * colWidth, h - barHeight, Math.max(1, colWidth - 0.5), barHeight);
    }
  }
}
