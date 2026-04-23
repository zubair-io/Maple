// Waveform scope — real luma column scan from decoded pixels, pseudo fallback.

import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  inject,
  input,
} from '@angular/core';
import { AdjustmentModel } from '@maple-common';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import type { DecodedImage } from '@maple-common';

@Component({
  selector: 'editor-waveform',
  standalone: true,
  template: `<canvas #canvas width="200" height="80" style="display:block;width:100%;height:80px"></canvas>`,
  styles: [`:host { display: block; }`],
})
export class WaveformComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  adjustment = input.required<AdjustmentModel>();

  private canvasSvc = inject(ImageCanvasService);
  private cleanupEffect?: () => void;

  ngAfterViewInit(): void {
    const e = effect(() => {
      const adj    = this.adjustment();
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
    ctx.clearRect(0, 0, W, H);

    const rgb    = img.rgb;
    const imgW   = img.width;
    const imgH   = img.height;
    const colBuckets = W;

    // Build luma columns: for each output column, sample pixels from that image column range.
    // Accumulate into a 2D density array [col][luma_bin].
    const density = new Float32Array(colBuckets * 256);

    for (let px = 0; px < rgb.length; px += 3) {
      const pixIdx  = px / 3;
      const col     = Math.floor((pixIdx % imgW) / imgW * colBuckets);
      const luma    = (0.2126 * rgb[px] + 0.7152 * rgb[px + 1] + 0.0722 * rgb[px + 2]) | 0;
      density[col * 256 + luma]++;
    }

    // Find max density for normalisation.
    let maxD = 1;
    for (let i = 0; i < density.length; i++) {
      if (density[i] > maxD) maxD = density[i];
    }

    const imgData = ctx.createImageData(W, H);
    const d = imgData.data;

    for (let col = 0; col < colBuckets; col++) {
      for (let bin = 0; bin < 256; bin++) {
        const val = density[col * 256 + bin] / maxD;
        if (val < 0.001) continue;
        const y = H - 1 - Math.floor(bin / 256 * H);
        if (y < 0 || y >= H) continue;
        const alpha = Math.min(255, val * 800);
        const idx = (y * W + col) * 4;
        d[idx]     = Math.min(255, d[idx]     + 160);
        d[idx + 1] = Math.min(255, d[idx + 1] + 200);
        d[idx + 2] = Math.min(255, d[idx + 2] + 255);
        d[idx + 3] = Math.min(255, d[idx + 3] + alpha);
      }
    }
    ctx.putImageData(imgData, 0, 0);

    // Grid lines at 0, 50, 100 IRE.
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

  private renderPseudo(model: AdjustmentModel): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

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
