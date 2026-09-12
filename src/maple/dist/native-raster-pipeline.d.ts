/**
 * `bun:ffi` wrapper for `maple_raster_pipeline_buf` — the recipe entry point
 * (#3505). Split out of `native.ts` to keep that file inside the repo's
 * file-size budget; see `raw-pipeline/raw-ffi/src/raster_pipeline.rs` for the
 * C ABI and `raw-core/src/raster_recipe.rs` for the recipe schema.
 */
export interface RasterPipelineResult {
    ok: boolean;
    buffer?: Buffer;
    width?: number;
    height?: number;
    channels?: number;
    error?: string;
}
export interface RasterPipelineBinding {
    rasterPipelineBuf(input: Uint8Array, recipeJson: string, aux: Uint8Array): RasterPipelineResult;
}
export declare function createRasterPipelineBinding(lib: {
    symbols: Record<string, (...args: unknown[]) => unknown>;
}, ptr: (buf: Uint8Array) => unknown, getLastError: () => string | null): RasterPipelineBinding;
