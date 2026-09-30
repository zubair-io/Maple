import type { Recipe, RecipeOp } from './recipe';
import type { RasterMetadataProbe } from './native-raster-v2';

/**
 * Ceiling on the pixel count `rasterDecodeRgb8Buf` will allocate for straight
 * from a header, matching raw-core's `AVIF_MAX_FRAME_PIXELS`. The dimensions
 * come from the file's own header, before any decoder has validated it, so
 * without a ceiling a hostile TIFF/PNG declaring 100000x100000 would turn a
 * documented `{ ok: false, error }` into a `RangeError` thrown out of
 * `Buffer.alloc`. Past the ceiling the code takes the null-buffer size probe
 * instead, which allocates nothing until the decoder agrees on a size.
 */

export const MAX_PROBE_SIZED_PIXELS = 268_000_000;
const MIN_CAPACITY = 65536;

function targetPixels(width: unknown, height: unknown): number {
  const w = typeof width === 'number' && Number.isSafeInteger(width) && width > 0 ? width : 0;
  const h = typeof height === 'number' && Number.isSafeInteger(height) && height > 0 ? height : 0;
  const pixels = (w || h) * (h || w);
  return Number.isSafeInteger(pixels) && pixels <= MAX_PROBE_SIZED_PIXELS ? pixels : 0;
}

/** A first-call estimate, never a correctness bound: native rc 100 can grow it. */
export function initialRenderCapacity(
  inputSize: number,
  width: unknown,
  height: unknown,
  format: unknown,
): number {
  if (!width && !height) return Math.max(MIN_CAPACITY, inputSize * 2);
  const pixels = targetPixels(width, height);
  // Compressed thumbnails usually fit well below one byte per pixel. PNG,
  // lossless WebP and 16-bit TIFF need a larger first guess.
  const perPixel = format === 'jpeg' || format === 'avif' ? 1 : format === 'tiff' ? 8 : 4;
  return Math.max(MIN_CAPACITY, pixels * perPixel + MIN_CAPACITY);
}

export function initialPipelineCapacity(
  input: Uint8Array,
  recipeJson: string,
  probeMetadata: (bytes: Uint8Array) => RasterMetadataProbe,
): number {
  let recipe: Recipe;
  try {
    recipe = JSON.parse(recipeJson) as Recipe;
  } catch {
    // Let Rust report malformed recipes through the normal error contract.
    return MIN_CAPACITY;
  }
  if (!recipe || !Array.isArray(recipe.ops)) return MIN_CAPACITY;
  const target = recipe.ops.reduce<Extract<RecipeOp, { op: 'resize' | 'extract' }> | undefined>(
    (latest, op) => (op?.op === 'resize' || op?.op === 'extract' ? op : latest),
    undefined,
  );
  const format = recipe.output?.format;
  if (target && (target.width || target.height)) {
    return initialRenderCapacity(input.byteLength, target.width, target.height, format);
  }
  if (format === 'raw') {
    // Full-size raw terminals cannot be sized from compressed input bytes.
    // Four channels cover RGB, grey and ensureAlpha without another decode.
    const raw = recipe.input?.kind === 'raw' ? recipe.input : null;
    const probe = raw ? null : probeMetadata(input);
    const meta = raw ?? (probe?.ok ? probe.metadata : null);
    const pixels =
      meta && (raw || probe?.metadata?.format !== 'dng')
        ? targetPixels(meta.width, meta.height)
        : 0;
    return Math.max(MIN_CAPACITY, pixels * 4);
  }
  return Math.max(MIN_CAPACITY, input.byteLength * 2);
}
