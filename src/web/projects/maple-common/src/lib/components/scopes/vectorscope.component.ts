// Vectorscope — real Cb/Cr color plot from decoded pixels; pseudo fallback.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  inject,
  input,
} from '@angular/core';
import { AdjustmentModel } from '../../models/adjustment-model';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';

@Component({
  selector: 'editor-vectorscope',
  standalone: true,
  template: `<canvas
    #canvas
    width="80"
    height="80"
    style="display:block;width:80px;height:80px"
  ></canvas>`,
  styles: [
    `
      :host {
        display: block;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VectorscopeComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  adjustment = input.required<AdjustmentModel>();

  private canvasSvc = inject(ImageCanvasService);
  private cleanupEffect?: () => void;

  ngAfterViewInit(): void {
    const e = effect(() => {
      const adj = this.adjustment();
      const pixels = this.canvasSvc.currentPixels();
      if (this.canvasRef) {
        if (pixels) {
          this.renderReal(pixels);
        } else {
          this.renderPseudo(adj);
        }
      }
    });
    this.cleanupEffect = () => e.destroy();
  }

  ngOnDestroy(): void {
    this.cleanupEffect?.();
  }

  private renderReal(img: DecodedImage): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = W / 2 - 4;

    ctx.clearRect(0, 0, W, H);
    this.drawScopeChrome(ctx, cx, cy, R);

    // Accumulate Cb/Cr density on the scope grid.
    const density = new Uint32Array(W * H);
    const rgb = img.rgb;
    // Sample every Nth pixel for speed (vectorscope is for hue/saturation shape).
    const stride = Math.max(1, Math.floor(rgb.length / (3 * 4096)));

    for (let i = 0; i < rgb.length; i += 3 * stride) {
      const r = rgb[i] / 255;
      const g = rgb[i + 1] / 255;
      const b = rgb[i + 2] / 255;

      // BT.601 Cb/Cr
      const cb = -0.168736 * r - 0.331264 * g + 0.5 * b; // range -0.5..+0.5
      const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;

      const px = Math.round(cx + cb * R * 2);
      const py = Math.round(cy - cr * R * 2);

      if (px >= 0 && px < W && py >= 0 && py < H) {
        density[py * W + px]++;
      }
    }

    let maxD = 1;
    for (let i = 0; i < density.length; i++) {
      if (density[i] > maxD) maxD = density[i];
    }

    const imgData = ctx.createImageData(W, H);
    const d = imgData.data;
    for (let i = 0; i < density.length; i++) {
      if (density[i] === 0) continue;
      const alpha = Math.min(255, (density[i] / maxD) * 1800);
      d[i * 4] = 180;
      d[i * 4 + 1] = 200;
      d[i * 4 + 2] = 255;
      d[i * 4 + 3] = alpha;
    }
    ctx.putImageData(imgData, 0, 0);

    // Re-draw chrome on top.
    this.drawScopeChrome(ctx, cx, cy, R);
  }

  private drawScopeChrome(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.stroke();

    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * R, cy + Math.sin(angle) * R);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fill();
  }

  private renderPseudo(model: AdjustmentModel): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = W / 2 - 4;

    ctx.clearRect(0, 0, W, H);
    this.drawScopeChrome(ctx, cx, cy, R);

    const satRadius = ((model.saturation + 100) / 200) * R * 0.7;
    const hueAngle = ((model.temperature - 2000) / 10000) * Math.PI * 2;
    const numDots = 120;

    for (let i = 0; i < numDots; i++) {
      const angle =
        hueAngle + (i / numDots) * Math.PI * 0.8 - Math.PI * 0.4 + Math.sin(i * 3.7) * 0.4;
      const dist = satRadius * (0.3 + Math.abs(Math.sin(i * 0.97)) * 0.7);
      const dotX = cx + Math.cos(angle) * dist;
      const dotY = cy + Math.sin(angle) * dist;
      const alpha = 0.4 + Math.sin(i * 7.3) * 0.25;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 1, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(180,200,255,${alpha})`;
      ctx.fill();
    }
  }
}
