// MuiVectorscope — the Maple UI design-system Vectorscope data plot
// (unified-component-catalog.md §2.6; a plot primitive). A chroma scatter
// plot on a circular graticule: each RGB sample is converted to BT.601
// Cb/Cr and plotted as a dot. Chrome (circle, spokes) uses the border
// token; dots use the accent token — both resolved from `--color-*` via
// `getComputedStyle` at draw time (see mui-waveform's `resolveColor`).

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  viewChild,
} from '@angular/core';
import { beginPlotDraw, resolveColor } from '../internal/plot-canvas';

export interface MuiVectorscopeSample {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

@Component({
  selector: 'mui-vectorscope',
  standalone: true,
  templateUrl: './mui-vectorscope.component.html',
  styleUrl: './mui-vectorscope.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiVectorscopeComponent {
  /** RGB samples, each channel 0..1. */
  readonly samples = input.required<readonly MuiVectorscopeSample[]>();
  readonly size = input<number>(64);
  readonly dotColor = input<string>('var(--color-primary)');

  readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  constructor() {
    effect(() => {
      this.samples();
      this.size();
      this.dotColor();
      this.draw();
    });
  }

  private draw(): void {
    const size = this.size();
    const frame = beginPlotDraw(this.canvas(), size, size);
    if (!frame) return;
    const { canvasEl, ctx } = frame;

    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 4;

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

    ctx.fillStyle = resolveColor(canvasEl, this.dotColor());
    for (const sample of this.samples()) {
      const cb = -0.168736 * sample.r - 0.331264 * sample.g + 0.5 * sample.b;
      const cr = 0.5 * sample.r - 0.418688 * sample.g - 0.081312 * sample.b;
      const x = cx + cb * radius * 2;
      const y = cy - cr * radius * 2;
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
