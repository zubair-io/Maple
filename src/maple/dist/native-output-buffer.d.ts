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
export declare const MAX_PROBE_SIZED_PIXELS = 268000000;
/** A first-call estimate, never a correctness bound: native rc 100 can grow it. */
export declare function initialRenderCapacity(inputSize: number, width: unknown, height: unknown, format: unknown): number;
export declare function initialPipelineCapacity(input: Uint8Array, recipeJson: string, probeMetadata: (bytes: Uint8Array) => RasterMetadataProbe): number;
