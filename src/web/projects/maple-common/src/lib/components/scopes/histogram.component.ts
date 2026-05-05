// Histogram — uses real decoded pixel data when available, falls back to
// pseudo-rendered data from the adjustment model hash.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  ViewChild,
  effect,
  inject,
  input,
} from '@angular/core';
import { AdjustmentModel } from '../../models/adjustment-model';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { computeRgbHistograms } from '../../raw-pipeline/image-utils';
import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';

function hashModel(m: AdjustmentModel): number {
  const vals = [
    m.exposure,
    m.contrast,
    m.highlights,
    m.shadows,
    m.whites,
    m.blacks,
    m.temperature / 100,
    m.tint,
    m.vibrance,
    m.saturation,
    m.clarity,
  ];
  return vals.reduce((acc, v, i) => acc + v * (i + 1) * 7, 0);
}

@Component({
  selector: 'editor-histogram',
  standalone: true,
  template: `<canvas
    #canvas
    width="200"
    height="80"
    class="block w-full h-20"
  ></canvas>`,
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistogramComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  adjustment = input.required<AdjustmentModel>();

  private canvasSvc = inject(ImageCanvasService);
  private readonly injector = inject(Injector);
  private cleanupEffect?: () => void;

  ngAfterViewInit(): void {
    const e = effect(
      () => {
        const adj = this.adjustment();
        const pixels = this.canvasSvc.currentPixels();
        if (this.canvasRef) {
          if (pixels) {
            this.renderReal(pixels);
          } else {
            this.renderPseudo(adj);
          }
        }
      },
      { injector: this.injector },
    );
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

    const { r, g, b, luma } = computeRgbHistograms(img);

    // Find peak for normalisation.
    let peak = 1;
    for (let i = 0; i < 256; i++) {
      peak = Math.max(peak, r[i], g[i], b[i], luma[i]);
    }

    const channels = [
      { bins: r, color: 'rgba(220,80,80,0.55)' },
      { bins: g, color: 'rgba(80,190,80,0.55)' },
      { bins: b, color: 'rgba(80,130,220,0.55)' },
      { bins: luma, color: 'rgba(200,190,180,0.4)' },
    ];

    // Downsample 256 bins to canvas width.
    const binW = W / 256;
    for (const ch of channels) {
      ctx.fillStyle = ch.color;
      for (let i = 0; i < 256; i++) {
        const h = (ch.bins[i] / peak) * (H - 2);
        ctx.fillRect(i * binW, H - h, Math.max(1, binW - 0.5), h);
      }
    }

    // Baseline
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, H - 0.5);
    ctx.lineTo(W, H - 0.5);
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

    const seed = hashModel(model);
    const bins = 64;
    const barW = W / bins;

    const channels = [
      { color: 'rgba(220,80,80,0.55)', offset: 0.0 },
      { color: 'rgba(80,190,80,0.55)', offset: 0.3 },
      { color: 'rgba(80,130,220,0.55)', offset: 0.6 },
      { color: 'rgba(200,190,180,0.4)', offset: 1.0 },
    ];

    for (const ch of channels) {
      ctx.beginPath();
      for (let i = 0; i < bins; i++) {
        const t = i / bins;
        const mu = 0.35 + ((seed * 0.007 + ch.offset * 0.15) % 0.3);
        const sigma = 0.12 + Math.abs(model.contrast) / 2000;
        const gauss = Math.exp(-0.5 * Math.pow((t - mu) / sigma, 2));
        const noise = (Math.sin(i * 17.3 + seed * 2.1) * 0.5 + 0.5) * 0.18;
        const h = Math.max(0, Math.min(1, gauss * 0.9 + noise)) * (H - 2);
        ctx.fillStyle = ch.color;
        ctx.fillRect(i * barW, H - h, barW - 0.5, h);
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, H - 0.5);
    ctx.lineTo(W, H - 0.5);
    ctx.stroke();
  }
}
