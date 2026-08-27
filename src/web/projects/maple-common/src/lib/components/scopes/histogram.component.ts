// Histogram — uses real decoded pixel data when available, falls back to
// pseudo-rendered data from the adjustment model hash. Composes
// `mui-histogram` (peak-relative R/G/B bars over a 256-bin canvas, same
// math as this wrapper's own former `renderReal`/`renderPseudo`) for the
// actual bar rendering; this wrapper's job is reducing to the `r`/`g`/`b`
// bin arrays it needs. `mui-histogram` has no luma channel (`RgbChannelPlotBase`
// is R/G/B-only) — the legacy 4th whitish luma overlay is dropped, a minor
// visual simplification (R/G/B stay full fidelity).

import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { AdjustmentModel } from '../../models/adjustment-model';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { computeRgbHistograms } from '../../raw-pipeline/image-utils';
import { MuiHistogramComponent } from '../../ui/histogram/mui-histogram.component';

const CANVAS_WIDTH = 200;
const CANVAS_HEIGHT = 80;
const PSEUDO_BINS = 64;

interface RgbBins {
  readonly r: readonly number[];
  readonly g: readonly number[];
  readonly b: readonly number[];
}

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

/** Same gaussian-plus-noise synthetic shape the old `renderPseudo` painted
 *  directly to canvas, now returning bin arrays instead — one per channel,
 *  offset the same way so the three curves stay visually distinct. */
function pseudoBins(model: AdjustmentModel): RgbBins {
  const seed = hashModel(model);
  const sigma = 0.12 + Math.abs(model.contrast) / 2000;
  const offsets: Record<keyof RgbBins, number> = { r: 0.0, g: 0.3, b: 0.6 };
  const channel = (offset: number): number[] =>
    Array.from({ length: PSEUDO_BINS }, (_, i) => {
      const t = i / PSEUDO_BINS;
      const mu = 0.35 + ((seed * 0.007 + offset * 0.15) % 0.3);
      const gauss = Math.exp(-0.5 * Math.pow((t - mu) / sigma, 2));
      const noise = (Math.sin(i * 17.3 + seed * 2.1) * 0.5 + 0.5) * 0.18;
      return Math.max(0, Math.min(1, gauss * 0.9 + noise));
    });
  return { r: channel(offsets.r), g: channel(offsets.g), b: channel(offsets.b) };
}

@Component({
  selector: 'editor-histogram',
  standalone: true,
  imports: [MuiHistogramComponent],
  templateUrl: './histogram.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistogramComponent {
  adjustment = input.required<AdjustmentModel>();

  private canvasSvc = inject(ImageCanvasService);

  protected readonly width = CANVAS_WIDTH;
  protected readonly height = CANVAS_HEIGHT;

  protected readonly bins = computed<RgbBins>(() => {
    const pixels = this.canvasSvc.currentPixels();
    if (pixels) {
      const { r, g, b } = computeRgbHistograms(pixels);
      return { r: Array.from(r), g: Array.from(g), b: Array.from(b) };
    }
    return pseudoBins(this.adjustment());
  });
}
