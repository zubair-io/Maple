// subject-mask-png.ts — PNG bytes → R8 raster (#3300).
//
// The server's raster endpoint serves grayscale PNGs (the same bytes Apple's
// `MaskRasterStore` caches on disk); the render worker's registry takes raw
// R8. Decoding rides the platform (`createImageBitmap` + 2D canvas) rather
// than a vendored PNG decoder. The vitest run has no `createImageBitmap`,
// so callers inject `SUBJECT_MASK_PNG_DECODER` and specs substitute a stub.

import { InjectionToken } from '@angular/core';

/** Row-major `width * height` coverage bytes, `0` = weight 0, `255` = 1. */
interface DecodedMaskRaster {
  width: number;
  height: number;
  data: Uint8Array;
}

type PngR8Decoder = (png: ArrayBuffer) => Promise<DecodedMaskRaster>;

/**
 * Decode a grayscale (+alpha-ignored) PNG into R8 coverage. Draws
 * unscaled — the server sizes rasters (1024px long edge, Apple's
 * `MaskRasterStore` policy), the client never resamples.
 */
async function decodePngR8(png: ArrayBuffer): Promise<DecodedMaskRaster> {
  const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Subject masks need a 2D canvas context.');
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const data = new Uint8Array(bitmap.width * bitmap.height);
    for (let i = 0; i < data.length; i++) data[i] = pixels[i * 4] ?? 0;
    return { width: bitmap.width, height: bitmap.height, data };
  } finally {
    bitmap.close();
  }
}

/** DI token so specs can stub the platform decode. */
export const SUBJECT_MASK_PNG_DECODER = new InjectionToken<PngR8Decoder>(
  'SUBJECT_MASK_PNG_DECODER',
  { providedIn: 'root', factory: () => decodePngR8 },
);
