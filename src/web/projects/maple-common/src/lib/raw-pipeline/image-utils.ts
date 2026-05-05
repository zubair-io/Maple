// Image utility helpers for converting raw-wasm output to browser-paintable types.

import type { DecodedImage } from './raw-pipeline.types';

/** Convert raw-wasm RGB output (packed R,G,B bytes) to an ImageBitmap. */
export async function imageDataToBitmap(img: DecodedImage): Promise<ImageBitmap> {
  const rgba = new Uint8ClampedArray(img.width * img.height * 4);
  const rgb = img.rgb;
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  const imageData = new ImageData(rgba, img.width, img.height);
  return createImageBitmap(imageData);
}

/**
 * Draw an ImageBitmap to an OffscreenCanvas (or regular canvas) scaled to
 * fit `maxDim` on the long edge.
 *
 * Falls back to a regular HTMLCanvasElement when OffscreenCanvas is unavailable
 * (older Safari / Firefox).
 */
export async function resizeBitmapToCanvas(
  bitmap: ImageBitmap,
  maxDim: number,
): Promise<OffscreenCanvas | HTMLCanvasElement> {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas;
  }

  // Fallback for environments without OffscreenCanvas.
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

/** Encode a canvas as a JPEG Blob. Works for both OffscreenCanvas and
 * HTMLCanvasElement. Used by callers that need to both render the image
 * (via blob URL) AND write it to the `.maple/thumbs/` cache (raw bytes). */
export async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality = 0.85,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      quality,
    );
  });
}

/** Convenience: encode + wrap the blob in an object URL. Use this when you
 * don't need the blob bytes for anything else. */
export async function canvasToBlobUrl(
  canvas: OffscreenCanvas | HTMLCanvasElement,
): Promise<string> {
  return URL.createObjectURL(await canvasToBlob(canvas));
}

/** Compute a 256-bin luma histogram from raw RGB pixel data. */
export function computeLumaHistogram(img: DecodedImage): Uint32Array {
  const bins = new Uint32Array(256);
  const rgb = img.rgb;
  for (let i = 0; i < rgb.length; i += 3) {
    const luma = (0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]) | 0;
    bins[luma]++;
  }
  return bins;
}

/** Compute per-channel 256-bin histograms (R, G, B, Luma). */
export function computeRgbHistograms(img: DecodedImage): {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
} {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const luma = new Uint32Array(256);
  const rgb = img.rgb;
  for (let i = 0; i < rgb.length; i += 3) {
    r[rgb[i]]++;
    g[rgb[i + 1]]++;
    b[rgb[i + 2]]++;
    const l = (0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]) | 0;
    luma[l]++;
  }
  return { r, g, b, luma };
}
