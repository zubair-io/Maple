/**
 * `bun:ffi` wrapper for `maple_raster_analyze_buf` — the read-only half of
 * the raster surface (#3507). JSON request in, JSON reply out; see
 * `raw-pipeline/raw-core/src/raster_analyze.rs` for the schema.
 */
export interface RasterAnalyzeBinding {
    rasterAnalyzeBuf(input: Uint8Array, requestJson: string): {
        ok: boolean;
        json?: string;
        error?: string;
    };
}
export declare function createRasterAnalyzeBinding(lib: {
    symbols: Record<string, (...args: unknown[]) => unknown>;
}, ptr: (buf: Uint8Array) => unknown, getLastError: () => string | null): RasterAnalyzeBinding;
