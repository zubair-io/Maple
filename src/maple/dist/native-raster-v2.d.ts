/**
 * Second-generation raster bindings: one general render entry point (fit,
 * filter, orientation, format, quality, AVIF effort), the same from
 * caller-supplied pixels, and a native-size RGB8 decode. Split out of
 * `native.ts` to keep that file under the repo's file-size budget — see
 * `raw-pipeline/raw-ffi/src/raster_v2.rs` for the C ABI these bind against.
 */
/**
 * The part of `native.ts`'s header probe that `rasterDecodeRgb8Buf` needs to
 * size its output buffer without decoding the image first.
 */
export interface RasterMetadataProbe {
    ok: boolean;
    metadata?: {
        width: number;
        height: number;
        channels: number;
        orientation: number;
        format: string;
    };
    error?: string;
}
export interface RasterV2Binding {
    rasterRenderBuf(inputBytes: Uint8Array, width: number, height: number, flags: number, filter: number, format: string | null, quality: number, effort: number): {
        ok: boolean;
        buffer?: Buffer;
        error?: string;
    };
    rasterFromRawRenderBuf(pixels: Uint8Array, srcWidth: number, srcHeight: number, channels: number, width: number, height: number, flags: number, filter: number, format: string | null, quality: number, effort: number): {
        ok: boolean;
        buffer?: Buffer;
        error?: string;
    };
    rasterDecodeRgb8Buf(inputBytes: Uint8Array, autoOrient: boolean): {
        ok: boolean;
        buffer?: Buffer;
        width?: number;
        height?: number;
        error?: string;
    };
}
/**
 * Build the raster-v2 methods, closing over the caller's `dlopen` handle.
 * `probeMetadata` is the header probe from `native.ts`; `rasterDecodeRgb8Buf`
 * uses it to size its output so the image is decoded once, not twice.
 */
export declare function createRasterV2Binding(lib: {
    symbols: Record<string, (...args: unknown[]) => unknown>;
}, ptr: (buf: Uint8Array) => unknown, getLastError: () => string | null, probeMetadata: (inputBytes: Uint8Array) => RasterMetadataProbe): RasterV2Binding;
