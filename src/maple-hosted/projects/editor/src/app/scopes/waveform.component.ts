// Waveform scope — pseudo-rendered luma column scan.

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
  selector: 'editor-waveform',
  standalone: true,
  template: `<canvas #canvas width="200" height="80" style="display:block;width:100%;height:80px"></canvas>`,
  styles: [`:host { display: block; }`],
})
export class WaveformComponent implements AfterViewInit, OnDestroy {
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

    // Draw waveform columns
    const expShift = model.exposure * 0.08;
    const contMul  = 1 + model.contrast / 200;

    for (let x = 0; x < W; x++) {
      const t = x / W;
      const base = 0.5 + Math.sin(t * Math.PI * 3 + 0.7) * 0.25 + expShift;
      const lo   = Math.max(0, base - 0.12 * contMul);
      const hi   = Math.min(1, base + 0.12 * contMul);
      const yHi  = (1 - hi) * H;
      const yLo  = (1 - lo) * H;

      const grad = ctx.createLinearGradient(0, yHi, 0, yLo);
      grad.addColorStop(0, 'rgba(160,200,255,0.08)');
      grad.addColorStop(0.5, 'rgba(160,200,255,0.6)');
      grad.addColorStop(1, 'rgba(160,200,255,0.08)');

      ctx.fillStyle = grad;
      ctx.fillRect(x, yHi, 1, Math.max(1, yLo - yHi));
    }

    // Grid lines at 0, 50, 100 IRE
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.5;
    for (const frac of [0, 0.5, 1]) {
      const y = frac * H;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
  }
}
