// Vectorscope — 2D color plot; trace rotates with hue, expands with saturation.

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
  selector: 'editor-vectorscope',
  standalone: true,
  template: `<canvas #canvas width="80" height="80" style="display:block;width:80px;height:80px"></canvas>`,
  styles: [`:host { display: block; }`],
})
export class VectorscopeComponent implements AfterViewInit, OnDestroy {
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
    const cx = W / 2;
    const cy = H / 2;
    const R  = W / 2 - 4;

    ctx.clearRect(0, 0, W, H);

    // Background circle
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // 50% circle
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.stroke();

    // Hue spokes (6 primaries)
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * R, cy + Math.sin(angle) * R);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.stroke();
    }

    // Pseudo trace: a cloud of dots scaled by saturation
    const satRadius = (model.saturation + 100) / 200 * R * 0.7;
    const hueAngle  = ((model.temperature - 2000) / 10000) * Math.PI * 2;
    const numDots   = 120;

    for (let i = 0; i < numDots; i++) {
      const angle = hueAngle + (i / numDots) * Math.PI * 0.8 - Math.PI * 0.4
                  + Math.sin(i * 3.7) * 0.4;
      const dist  = satRadius * (0.3 + Math.abs(Math.sin(i * 0.97)) * 0.7);
      const dotX  = cx + Math.cos(angle) * dist;
      const dotY  = cy + Math.sin(angle) * dist;
      const alpha = 0.4 + Math.sin(i * 7.3) * 0.25;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 1, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(180,200,255,${alpha})`;
      ctx.fill();
    }

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fill();
  }
}
