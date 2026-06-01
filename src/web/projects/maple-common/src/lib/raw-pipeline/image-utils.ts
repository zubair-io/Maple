// Image utility helpers for converting raw-wasm output to browser-paintable types.

import type { DecodedImage, DecodedSceneLinearImage } from './raw-pipeline.types';

/**
 * Decode a non-RAW image (jpg/png/heic/webp/tiff/…) via the browser instead
 * of the Rust RAW pipeline. Mirrors Apple's ImageIO non-RAW path
 * (`decodeSceneLinearNonRaw`): these files already ship demosaiced,
 * display-encoded pixels, so they must NOT go through rawler/demosaic/WB.
 *
 * `createImageBitmap` honours the file's embedded colour profile and hands
 * back display-referred pixels; we draw to a 2D canvas and read back RGBA.
 * The returned `DecodedImage.rgb` is packed display sRGB 8-bit (3 * w * h) —
 * the same contract as the WASM `render_bytes` legacy path.
 *
 * White-balance metadata doesn't exist for a developed image, so we report
 * neutral as-shot values (6500 K / 0 tint). `seedAsShotWhiteBalance` treats
 * those as "still default" and no-ops, leaving the WB sliders untouched.
 *
 * Browser support note: `createImageBitmap` decodes JPEG/PNG/WebP everywhere,
 * HEIC only where the platform's image decoder supports it (Safari), and not
 * TIFF. Unsupported formats reject here and the caller's catch nulls the
 * bitmap — graceful, no RAW-pipeline fallback.
 */
export async function decodeNonRawToRgb(bytes: Uint8Array): Promise<DecodedImage> {
  // Copy into a standalone ArrayBuffer-backed view so the Blob owns its bytes
  // regardless of whether `bytes` is a view over a larger/transferred buffer.
  const blob = new Blob([bytes.slice() as unknown as BlobPart]);
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    const ctx = make2dContext(width, height);
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    // Pack RGBA → RGB (drop alpha) to match the WASM legacy contract.
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }
    return {
      width,
      height,
      rgb,
      asShotTemperature: 6500,
      asShotTint: 0,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Scene-linear counterpart of {@link decodeNonRawToRgb}: decode a non-RAW
 * image via the browser and convert its display-sRGB pixels into the
 * scene-linear Rec.2020 fp16 RGBA working space the WebGL pipeline consumes —
 * matching the RAW `decodeSceneLinear` output contract.
 *
 * Per Apple's `decodeSceneLinearNonRaw`: undo the sRGB transfer (display →
 * scene-linear) and rotate the sRGB/Rec.709 primaries into Rec.2020. Alpha is
 * fp16 1.0 (0x3c00), matching the RAW path and Apple's buffer layout.
 */
export async function decodeNonRawToSceneLinear(
  bytes: Uint8Array,
): Promise<DecodedSceneLinearImage> {
  const blob = new Blob([bytes.slice() as unknown as BlobPart]);
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    const ctx = make2dContext(width, height);
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    const fp16Rgba = new Uint16Array(width * height * 4);
    const ONE = 0x3c00; // fp16 1.0
    for (let i = 0, j = 0; i < data.length; i += 4, j += 4) {
      const r = srgbToLinear(data[i] / 255);
      const g = srgbToLinear(data[i + 1] / 255);
      const b = srgbToLinear(data[i + 2] / 255);
      // sRGB/Rec.709 linear → Rec.2020 linear.
      const r2 = SRGB_TO_REC2020[0] * r + SRGB_TO_REC2020[1] * g + SRGB_TO_REC2020[2] * b;
      const g2 = SRGB_TO_REC2020[3] * r + SRGB_TO_REC2020[4] * g + SRGB_TO_REC2020[5] * b;
      const b2 = SRGB_TO_REC2020[6] * r + SRGB_TO_REC2020[7] * g + SRGB_TO_REC2020[8] * b;
      fp16Rgba[j] = f32ToF16(r2);
      fp16Rgba[j + 1] = f32ToF16(g2);
      fp16Rgba[j + 2] = f32ToF16(b2);
      fp16Rgba[j + 3] = ONE;
    }
    return {
      width,
      height,
      fp16Rgba,
      asShotTemperature: 6500,
      asShotTint: 0,
    };
  } finally {
    bitmap.close();
  }
}

/** Create a 2D drawing context sized to `w`×`h`, preferring OffscreenCanvas. */
function make2dContext(
  w: number,
  h: number,
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('decodeNonRaw: 2D context unavailable (OffscreenCanvas)');
    return ctx;
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('decodeNonRaw: 2D context unavailable');
  return ctx;
}

/** sRGB display transfer → linear (IEC 61966-2-1). */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Linear sRGB/Rec.709 (D65) → linear Rec.2020 (D65), row-major 3×3.
// Matches the Bradford-free D65→D65 conversion used by the Rust core; see
// docs/architecture.md § "Scene-linear chain".
const SRGB_TO_REC2020 = [
  0.6274039, 0.329283, 0.0433131, 0.0690973, 0.9195404, 0.0113623, 0.0163914, 0.0880133, 0.8955953,
];

// fp16 (IEEE 754 half) encoder. Mirrors the bit layout produced by the Rust
// core's `f32 → f16` lane packing so the WebGL `HALF_FLOAT` upload matches the
// RAW path byte-for-byte.
const f32Buf = new Float32Array(1);
const u32Buf = new Uint32Array(f32Buf.buffer);
function f32ToF16(value: number): number {
  f32Buf[0] = value;
  const x = u32Buf[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  const mantissa = x & 0x7fffff;
  if (exp <= 0) {
    // Subnormal / underflow to zero (scene-linear values are >= 0 and small
    // negatives from the gamut rotation flush to 0 — acceptable, matches clamp).
    if (exp < -10) return sign;
    const m = (mantissa | 0x800000) >>> (1 - exp);
    return sign | (m >>> 13);
  }
  if (exp >= 0x1f) {
    // Overflow → fp16 infinity. Scene-linear highlights shouldn't reach this,
    // but clamp defensively rather than wrap.
    return sign | 0x7c00;
  }
  return sign | (exp << 10) | (mantissa >>> 13);
}

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
