// scope-sample.ts — reduce a decoded RGB frame into the four scope plots
// the Maple UI scopes panel draws (#2449, milestone 18 design spec §2.4).
//
// The render worker already reads back a small downsampled RGB snapshot of
// every presented frame (`readbackScopeSnapshot`, raw-pipeline.worker.ts)
// and `ImageCanvasComponent` publishes it as `ImageCanvasService.currentPixels`
// — the same `DecodedImage` the top-bar histogram reduces. This module is
// the pure reduction from that frame to `MuiScopeSample`: peak-relative RGB
// histograms, a per-column luma waveform, a per-column RGB parade, and a
// subsampled cloud of chroma samples for the vectorscope. Pure functions,
// no Angular, so the shapes are unit-testable on a synthetic frame.

import type { DecodedImage } from '../../raw-pipeline/raw-pipeline.types';
import type { MuiScopeSample } from '../../ui/scopes-panel/mui-scopes-panel.component';
import type { MuiVectorscopeSample } from '../../ui/vectorscope/mui-vectorscope.component';
import { computeRgbHistograms } from '../../raw-pipeline/image-utils';

/** Columns in the waveform / parade plots. */
export const SCOPE_COLUMNS = 64;
/** Upper bound on vectorscope dots per frame. */
export const VECTORSCOPE_SAMPLES = 256;

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** Peak-relative 0..1 bins, so an all-black frame stays flat instead of NaN. */
function normalisePeak(bins: Uint32Array): number[] {
  const peak = bins.reduce((max, v) => Math.max(max, v), 0);
  const scale = peak > 0 ? 1 / peak : 0;
  return Array.from(bins, (v) => v * scale);
}

interface ColumnMeans {
  readonly r: number[];
  readonly g: number[];
  readonly b: number[];
  readonly luma: number[];
}

/** Mean R / G / B / luma per column bucket, each 0..1. */
function columnMeans(img: DecodedImage, columns: number): ColumnMeans {
  const { width, height, rgb } = img;
  const sumR = new Float64Array(columns);
  const sumG = new Float64Array(columns);
  const sumB = new Float64Array(columns);
  const count = new Uint32Array(columns);
  for (let y = 0; y < height; y++) {
    const rowBase = y * width * 3;
    for (let x = 0; x < width; x++) {
      const column = Math.min(columns - 1, Math.floor((x * columns) / width));
      const i = rowBase + x * 3;
      sumR[column] += rgb[i];
      sumG[column] += rgb[i + 1];
      sumB[column] += rgb[i + 2];
      count[column]++;
    }
  }
  const mean = (sum: Float64Array, column: number) =>
    count[column] > 0 ? sum[column] / (count[column] * 255) : 0;
  const r = Array.from({ length: columns }, (_, c) => mean(sumR, c));
  const g = Array.from({ length: columns }, (_, c) => mean(sumG, c));
  const b = Array.from({ length: columns }, (_, c) => mean(sumB, c));
  const luma = r.map((rv, c) => LUMA_R * rv + LUMA_G * g[c] + LUMA_B * b[c]);
  return { r, g, b, luma };
}

/** Every `stride`-th pixel as a 0..1 RGB triple, at most `limit` of them. */
function chromaSamples(img: DecodedImage, limit: number): MuiVectorscopeSample[] {
  const pixels = img.width * img.height;
  if (pixels === 0) return [];
  const stride = Math.max(1, Math.ceil(pixels / limit));
  const out: MuiVectorscopeSample[] = [];
  for (let p = 0; p < pixels && out.length < limit; p += stride) {
    const i = p * 3;
    out.push({ r: img.rgb[i] / 255, g: img.rgb[i + 1] / 255, b: img.rgb[i + 2] / 255 });
  }
  return out;
}

/** The four scope plots for one decoded frame. */
export function scopeSampleFromPixels(
  img: DecodedImage,
  columns: number = SCOPE_COLUMNS,
  vectorSamples: number = VECTORSCOPE_SAMPLES,
): MuiScopeSample {
  const histograms = computeRgbHistograms(img);
  const means = columnMeans(img, columns);
  return {
    histogram: {
      r: normalisePeak(histograms.r),
      g: normalisePeak(histograms.g),
      b: normalisePeak(histograms.b),
    },
    waveformLuma: means.luma,
    parade: { r: means.r, g: means.g, b: means.b },
    vectorscope: chromaSamples(img, vectorSamples),
  };
}
