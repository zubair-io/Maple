// Image utility helpers for converting raw-wasm output to browser-paintable types.

import type { DecodedImage, DecodedSceneLinearImage } from './raw-pipeline.types';
import { SRGB_TO_REC2020 } from '../generated/color-matrices.generated';

/**
 * Decode a non-RAW image (jpg/png/heic/webp/tiff/…) via the browser instead
 * of the Rust RAW pipeline. Mirrors Apple's ImageIO non-RAW path
 * (`decodeSceneLinearNonRaw`): these files already ship demosaiced,
 * display-encoded pixels, so they must NOT go through rawler/demosaic/WB.
 *
 * `createImageBitmap` honours the file's embedded colour profile and hands
 * back display-referred pixels; we draw to a 2D canvas and read back RGBA.
 * `imageOrientation: 'from-image'` applies the EXIF/TIFF orientation tag so
 * iPhone HEIC/JPEG captures (stored landscape + an orientation tag) come back
 * already rotated to display orientation — matching Apple's
 * `decodeSceneLinearNonRaw`, which applies `CIImage.oriented(forExifOrientation:)`.
 * Without it portrait photos open sideways. The returned `DecodedImage.rgb` is
 * packed display sRGB 8-bit (3 * w * h) — the same contract as the WASM
 * `render_bytes` legacy path.
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
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
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
 *
 * `imageOrientation: 'from-image'` applies the EXIF orientation tag so the
 * decoded bitmap is already in display orientation (width/height swapped for
 * 90°/270° captures) — parity with Apple's `CIImage.oriented(forExifOrientation:)`.
 */
export async function decodeNonRawToSceneLinear(
  bytes: Uint8Array,
): Promise<DecodedSceneLinearImage> {
  const blob = new Blob([bytes.slice() as unknown as BlobPart]);
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const { width, height } = bitmap;
    const ctx = make2dContext(width, height);
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    const fp16Rgba = new Uint16Array(width * height * 4);
    const ONE = 0x3c00; // fp16 1.0
    // Canvas pixels are 8-bit, so the sRGB→linear transfer has only 256 distinct
    // inputs. Precompute the exact mapping once (lazily memoized) and index it by
    // the integer byte to avoid millions of Math.pow calls on the main thread.
    const lut = srgbToLinearLut();
    for (let i = 0, j = 0; i < data.length; i += 4, j += 4) {
      const r = lut[data[i]];
      const g = lut[data[i + 1]];
      const b = lut[data[i + 2]];
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

// Lazily-built 256-entry lookup table: index = the raw 0–255 canvas byte,
// value = srgbToLinear(byte / 255). Exact for every 8-bit input — the loop in
// decodeNonRawToSceneLinear used to call srgbToLinear per channel per pixel.
let srgbToLinearLutCache: Float64Array | null = null;
function srgbToLinearLut(): Float64Array {
  if (srgbToLinearLutCache === null) {
    const lut = new Float64Array(256);
    for (let b = 0; b < 256; b++) {
      lut[b] = srgbToLinear(b / 255);
    }
    srgbToLinearLutCache = lut;
  }
  return srgbToLinearLutCache;
}

// fp16 (IEEE 754 half) encoder. Ports `raw_core::pipeline::fp16::f32_to_f16_bits`
// (`src/raw-pipeline/raw-core/src/pipeline/fp16.rs`) BIT-FOR-BIT — including its
// round-to-nearest-even rounding in the normal range — so the WebGL
// `HALF_FLOAT` upload matches the Rust core's fp16 lane packing exactly, not
// just approximately. The previous form (`mantissa >>> 13`) was a bare
// truncation: every conversion rounded toward zero instead of to the nearest
// representable fp16 value, a small but real, systematically one-sided bias
// on every non-RAW pixel. #1944.
const f32Buf = new Float32Array(1);
const u32Buf = new Uint32Array(f32Buf.buffer);
export function f32ToF16(value: number): number {
  f32Buf[0] = value;
  const bits = u32Buf[0];
  const sign = (bits >>> 16) & 0x8000;
  const storedExp = (bits >>> 23) & 0xff;
  const mantBits = bits & 0x007fffff;

  if (storedExp === 0xff) {
    // Inf / NaN — preserve NaN-ness via a non-zero mantissa flag.
    return sign | 0x7c00 | (mantBits !== 0 ? 0x0001 : 0);
  }

  const unbiasedExp = storedExp - 127;
  const fp16Exp = unbiasedExp + 15;

  if (fp16Exp >= 31) {
    // Overflow → fp16 infinity. Scene-linear highlights shouldn't reach this,
    // but clamp defensively rather than wrap.
    return sign | 0x7c00;
  }

  if (fp16Exp <= 0) {
    // Subnormal / underflow to zero (scene-linear values are >= 0 and small
    // negatives from the gamut rotation flush to 0 — acceptable, matches clamp).
    if (fp16Exp < -10) return sign;
    // Add the implicit 1 and shift right to align in fp16 space (fp16
    // subnormal precision = 10 bits below 2^-14), keeping 1 guard bit for a
    // round-half-up on the shifted-out bit.
    const mantWithImplicit = mantBits | 0x00800000;
    const shift = 14 - unbiasedExp;
    const shifted = mantWithImplicit >>> (shift - 10 - 1);
    const rounded = (shifted + 1) >>> 1;
    return sign | (rounded & 0x03ff);
  }

  // Normal range. Extract top 10 mantissa bits, rounding to nearest-even on
  // the next bit (ties — round bit set, no lower bits set — round to whichever
  // of the two candidates has an even low bit).
  const top10 = (mantBits >>> 13) & 0x03ff;
  const roundBit = (mantBits >>> 12) & 0x1;
  const stickyBits = mantBits & 0x0fff;
  let fp16Mant = top10;
  if (roundBit !== 0 && (stickyBits !== 0 || (fp16Mant & 0x1) !== 0)) {
    fp16Mant += 1;
    if (fp16Mant > 0x3ff) {
      // Mantissa overflow on round — bump exponent, mantissa goes to 0.
      const bumpedExp = fp16Exp + 1;
      if (bumpedExp >= 31) {
        return sign | 0x7c00;
      }
      return sign | (bumpedExp << 10);
    }
  }
  return sign | (fp16Exp << 10) | fp16Mant;
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

export type ThumbFormat = 'avif' | 'jpeg';
export interface EncodedThumb {
  blob: Blob;
  format: ThumbFormat;
}

// Canvas quality is a 0–1 float — NOT sharp/Rust's 0–100 int scale used by
// the server-side AVIF encoder. Client- and server-origin thumbnails already
// differ in encoder/quality mapping today; no attempt is made to match them.
const AVIF_THUMB_QUALITY = 0.6;
const JPEG_THUMB_QUALITY = 0.85;

/** Low-level: encode a canvas to a specific MIME type. The returned Blob's
 * `.type` may differ from `mime` — some engines silently substitute a
 * different format (commonly PNG) for an unsupported requested type rather
 * than erroring. Callers MUST inspect the returned `.type`, not assume it
 * matches what was requested. */
function encodeCanvas(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  mime: string,
  quality: number,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: mime, quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      mime,
      quality,
    );
  });
}

// One-time memoized capability probe — avoids paying an AVIF-attempt-then-
// JPEG-re-encode cost on every thumbnail for browsers that can't encode AVIF.
let avifEncodeSupported: boolean | null = null;
async function canEncodeAvif(): Promise<boolean> {
  if (avifEncodeSupported !== null) return avifEncodeSupported;
  try {
    const probe =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1)
        : Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
    const blob = await encodeCanvas(probe, 'image/avif', AVIF_THUMB_QUALITY);
    avifEncodeSupported = blob.type === 'image/avif';
  } catch {
    avifEncodeSupported = false;
  }
  return avifEncodeSupported;
}

/**
 * Encode a canvas as an AVIF thumbnail, falling back to JPEG when the
 * browser can't actually produce AVIF (verified via the returned Blob's
 * `.type`, not just a successful call — see `encodeCanvas`). Reports which
 * format was produced so the caller can persist it under the matching
 * extension. Works for both OffscreenCanvas and HTMLCanvasElement.
 */
export async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
): Promise<EncodedThumb> {
  if (await canEncodeAvif()) {
    const blob = await encodeCanvas(canvas, 'image/avif', AVIF_THUMB_QUALITY);
    if (blob.type === 'image/avif') return { blob, format: 'avif' };
  }
  const blob = await encodeCanvas(canvas, 'image/jpeg', JPEG_THUMB_QUALITY);
  return { blob, format: 'jpeg' };
}

/** Convenience: encode + wrap the blob in an object URL. Use this when you
 * don't need the blob bytes for anything else. */
export async function canvasToBlobUrl(
  canvas: OffscreenCanvas | HTMLCanvasElement,
): Promise<string> {
  const { blob } = await canvasToBlob(canvas);
  return URL.createObjectURL(blob);
}

/** Long-edge cap for the preview cache tier (unedited AND edited/developed —
 * #2018) — matches the server's `PREVIEW_LONG_EDGE_PX` and
 * `EmbeddedPreviewService`'s own default. The unedited-tier's extracted
 * preview is already resized to this by the WASM binding, so it's a ceiling
 * (scale 1, no upscale) for that transcode; the edited tier's caller
 * (`EditPreviewPersistService`) passes it straight to `RawPipelineService.decode`'s
 * `maxLongEdge` so the develop itself downsamples to this size, matching the
 * contract exactly rather than resizing after the fact. Exported for that
 * reuse. */
export const PREVIEW_LONG_EDGE_PX = 1280;

/** AVIF quality for the developed-preview cache tier (canvas 0–1 scale). ~0.7
 * per the #1993 preview contract ("quality ~70") — higher than the 0.6 grid
 * thumb because a 1280px preview is viewed full, not as a grid cell. */
const PREVIEW_AVIF_QUALITY = 0.7;

/** JPEG quality for the edit-time developed-preview fallback (#2018) —
 * deliberately HIGH (well above `PREVIEW_AVIF_QUALITY`'s 0.7) because the
 * server-backed path re-encodes it to AVIF and Hosted may retain it as the
 * final local cache artifact. Matches the
 * `heic-convert` intermediate-decode quality convention on the server side
 * (`thumbs/render.ts`'s `renderHeicThumbToFile`, quality 0.9) for the same
 * reason. */
const DEVELOPED_PREVIEW_JPEG_QUALITY = 0.92;

/**
 * Encode a raw-pipeline `DecodedImage` (the WASM develop's packed RGB output)
 * into a *genuine* AVIF blob, or `null` when this browser cannot encode AVIF.
 * `EditPreviewPersistService` uses a high-quality JPEG fallback when this
 * returns null; Hosted stores that real format locally, while the Self-Hosted
 * API transcodes it to its fixed AVIF artifact.
 */
export async function encodeDevelopedRenderToAvif(img: DecodedImage): Promise<Blob | null> {
  if (!(await canEncodeAvif())) return null;
  const bitmap = await imageDataToBitmap(img);
  try {
    const canvas = await resizeBitmapToCanvas(bitmap, PREVIEW_LONG_EDGE_PX);
    const blob = await encodeCanvas(canvas, 'image/avif', PREVIEW_AVIF_QUALITY);
    return blob.type === 'image/avif' ? blob : null;
  } finally {
    bitmap.close();
  }
}

/**
 * Encode a raw-pipeline `DecodedImage` into a high-quality JPEG blob. Every
 * engine's canvas can encode JPEG (unlike AVIF), so this never returns
 * `null`. Self-Hosted sends the JPEG to `PUT /api/preview` for AVIF transcode;
 * Hosted stores it directly with its actual `.jpg` descriptor.
 */
export async function encodeDevelopedRenderToJpeg(img: DecodedImage): Promise<Blob> {
  const bitmap = await imageDataToBitmap(img);
  try {
    const canvas = await resizeBitmapToCanvas(bitmap, PREVIEW_LONG_EDGE_PX);
    return await encodeCanvas(canvas, 'image/jpeg', DEVELOPED_PREVIEW_JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
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
