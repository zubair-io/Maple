// Parade scope — three stacked RGB waveforms.

import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  input,
} from '@angular/core';
import { AdjustmentModel } from '@maple-common';

@Component({
  selector: 'editor-parade',
  standalone: true,
  template: `<canvas #canvas width="200" height="80" style="display:block;width:100%;height:80px"></canvas>`,
  styles: [`:host { display: block; }`],
})
export class ParadeComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  adjustment = input.required<AdjustmentModel>();

  private cleanupEffect?: () => void;

  ngAfterViewInit(): void {
    const e = effect(() => {
      const adj = this.adjustment();
      if (this.canvasRef) this.render(adj);
    });
    this.cleanupEffect = () => e.destroy();
  }

  ngOnDestroy(): void {
    this.cleanupEffect?.();
  }

  private render(model: AdjustmentModel): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Three channels side by side
    const channels = [
      { color: 'rgba(220,60,60,0.7)',  phase: 0.0, gain: 1 + model.vibrance / 300 },
      { color: 'rgba(60,200,60,0.7)',  phase: 1.2, gain: 1 },
      { color: 'rgba(60,100,220,0.7)', phase: 2.4, gain: 1 + model.saturation / 300 },
    ];

    const panelW = Math.floor(W / 3);
    const expShift = model.exposure * 0.06;

    for (let ci = 0; ci < channels.length; ci++) {
      const ch = channels[ci];
      const xOff = ci * panelW;

      for (let x = 0; x < panelW; x++) {
        const t = x / panelW;
        const base = 0.5 + Math.sin(t * Math.PI * 2 + ch.phase) * 0.22 * ch.gain + expShift;
        const lo = Math.max(0, base - 0.10);
        const hi = Math.min(1, base + 0.10);
        const yHi = (1 - hi) * H;
        const yLo = (1 - lo) * H;

        ctx.fillStyle = ch.color;
        ctx.fillRect(xOff + x, yHi, 1, Math.max(1, yLo - yHi));
      }

      // Divider
      if (ci < 2) {
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(xOff + panelW, 0);
        ctx.lineTo(xOff + panelW, H);
        ctx.stroke();
      }
    }
  }
}
