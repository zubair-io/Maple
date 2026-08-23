// MuiWaveform — the Maple UI design-system Waveform data plot
// (unified-component-catalog.md §2.6; a plot primitive). A single-channel
// luma column plot. Unlike Histogram/Parade's literal RGB channel colors,
// a luma waveform has no inherent color of its own, so it reads the app's
// accent token — resolved from the live `--color-*` custom property via
// `getComputedStyle` at draw time, since a raw `ctx.fillStyle = 'var(...)'`
// string is not resolved by the Canvas 2D API.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  viewChild,
} from '@angular/core';
import { beginPlotDraw, resolveColor } from '../internal/plot-canvas';

@Component({
  selector: 'mui-waveform',
  standalone: true,
  templateUrl: './mui-waveform.component.html',
  styleUrl: './mui-waveform.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiWaveformComponent {
  /** Per-column luma samples, 0..1. */
  readonly luma = input.required<readonly number[]>();
  readonly width = input<number>(240);
  readonly height = input<number>(64);
  /** A literal color, or a `var(--token)` reference resolved at draw time. */
  readonly color = input<string>('var(--color-primary)');

  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  constructor() {
    effect(() => {
      this.luma();
      this.width();
      this.height();
      this.color();
      this.draw();
    });
  }

  private draw(): void {
    const w = this.width();
    const h = this.height();
    const frame = beginPlotDraw(this.canvas(), w, h);
    if (!frame) return;
    const { canvasEl, ctx } = frame;

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
