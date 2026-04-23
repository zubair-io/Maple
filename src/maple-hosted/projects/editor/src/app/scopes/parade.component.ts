// Parade scope — three RGB waveforms from real pixels when available.

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
  selector: 'editor-parade',
  standalone: true,
  template: `<canvas #canvas width="200" height="80" style="display:block;width:100%;height:80px"></canvas>`,
  styles: [`:host { display: block; }`],
})
export class ParadeComponent implements AfterViewInit, OnDestroy {
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

    const rgb   = img.rgb;
    const imgW  = img.width;
    const panelW = Math.floor(W / 3);

    // channel densities: [col][bin] for R, G, B
    const rDensity = new Float32Array(panelW * 256);
    const gDensity = new Float32Array(panelW * 256);
    const bDensity = new Float32Array(panelW * 256);

    for (let px = 0; px < rgb.length; px += 3) {
      const pixIdx = px / 3;
      const col    = Math.floor((pixIdx % imgW) / imgW * panelW);
      rDensity[col * 256 + rgb[px]]++;
      gDensity[col * 256 + rgb[px + 1]]++;
      bDensity[col * 256 + rgb[px + 2]]++;
    }

    let maxD = 1;
    for (let i = 0; i < rDensity.length; i++) {
      maxD = Math.max(maxD, rDensity[i], gDensity[i], bDensity[i]);
    }

    const channels = [
      { density: rDensity, r: 220, g: 60,  b: 60  },
      { density: gDensity, r: 60,  g: 200, b: 60  },
      { density: bDensity, r: 60,  g: 100, b: 220 },
    ];

    const imgData = ctx.createImageData(W, H);
    const d = imgData.data;

    for (let ci = 0; ci < channels.length; ci++) {
      const ch   = channels[ci];
      const xOff = ci * panelW;
      for (let col = 0; col < panelW; col++) {
        for (let bin = 0; bin < 256; bin++) {
          const val = ch.density[col * 256 + bin] / maxD;
          if (val < 0.001) continue;
          const y = H - 1 - Math.floor(bin / 256 * H);
          if (y < 0 || y >= H) continue;
          const alpha = Math.min(255, val * 800);
          const idx = (y * W + xOff + col) * 4;
          d[idx]     = Math.min(255, d[idx]     + ch.r);
          d[idx + 1] = Math.min(255, d[idx + 1] + ch.g);
          d[idx + 2] = Math.min(255, d[idx + 2] + ch.b);
          d[idx + 3] = Math.min(255, d[idx + 3] + alpha);
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);

    // Panel dividers.
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(panelW, 0);
    ctx.lineTo(panelW, H);
    ctx.moveTo(panelW * 2, 0);
    ctx.lineTo(panelW * 2, H);
    ctx.stroke();
  }

  private renderPseudo(model: AdjustmentModel): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

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
