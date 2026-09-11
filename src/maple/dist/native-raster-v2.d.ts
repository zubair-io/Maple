/**
 * Second-generation raster bindings: one general render entry point (fit,
 * filter, orientation, format, quality, AVIF effort), the same from
 * caller-supplied pixels, and a native-size RGB8 decode. Split out of
 * `native.ts` to keep that file under the repo's file-size budget — see
 * `raw-pipeline/raw-ffi/src/raster_v2.rs` for the C ABI these bind against.
 */
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
/** Build the raster-v2 methods, closing over the caller's `dlopen` handle. */
export declare function createRasterV2Binding(lib: {
    symbols: Record<string, (...args: unknown[]) => unknown>;
}, ptr: (buf: Uint8Array) => unknown, getLastError: () => string | null): RasterV2Binding;
