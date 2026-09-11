/**
 * `bun:ffi` wrapper for `maple_raster_pipeline_buf` — the recipe entry point
 * (#3505). Split out of `native.ts` to keep that file inside the repo's
 * file-size budget; see `raw-pipeline/raw-ffi/src/raster_pipeline.rs` for the
 * C ABI and `raw-core/src/raster_recipe.rs` for the recipe schema.
 */

/** rc from the C ABI for "your buffer was too small; `*out_len` is the size". */
const NEED_LARGER_BUFFER = 100;

/** Empty side-car buffer. `Buffer.alloc(0)` has no address `ptr()` can take. */
const EMPTY_AUX = Buffer.alloc(1);

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

export function createRasterPipelineBinding(
  lib: { symbols: Record<string, (...args: unknown[]) => unknown> },
  ptr: (buf: Uint8Array) => unknown,
  getLastError: () => string | null,
): RasterPipelineBinding {
  return {
    rasterPipelineBuf(input, recipeJson, aux) {
      const recipeBuf = Buffer.from(recipeJson + '\0', 'utf-8');
      const auxBuf = aux.byteLength > 0 ? aux : EMPTY_AUX;
      const auxLen = aux.byteLength;
      const outLenBuf = Buffer.alloc(8);
      const wBuf = Buffer.alloc(4);
      const hBuf = Buffer.alloc(4);
      const cBuf = Buffer.alloc(4);
      const call = (outBuf: Buffer | null) =>
        lib.symbols.maple_raster_pipeline_buf(
          ptr(input),
          BigInt(input.byteLength),
          ptr(recipeBuf),
          ptr(auxBuf),
          BigInt(auxLen),
          outBuf ? ptr(outBuf) : null,
          BigInt(outBuf ? outBuf.byteLength : 0),
          ptr(outLenBuf),
          ptr(wBuf),
          ptr(hBuf),
          ptr(cBuf),
        ) as number;
      const needed = () => Number(outLenBuf.readBigUInt64LE(0));
      const failed = (rc: number): RasterPipelineResult => ({
        ok: false,
        error: getLastError() || `Raster pipeline failed with code ${rc}`,
      });
      // One speculative call sized from the input, then at most one resize.
      // A recipe that grows the image (extend, contain letterboxing) is the
      // reason the first guess can fall short.
      const first = Buffer.alloc(Math.max(65536, input.byteLength * 2));
      const rc0 = call(first);
      if (rc0 === 0) {
        return {
          ok: true,
          buffer: first.subarray(0, needed()),
          width: wBuf.readUInt32LE(0),
          height: hBuf.readUInt32LE(0),
          channels: cBuf.readUInt32LE(0),
        };
      }
      if (rc0 !== NEED_LARGER_BUFFER) {
        return failed(rc0);
      }
      const grown = Buffer.alloc(needed());
      const rc = call(grown);
      return rc === 0
        ? {
            ok: true,
            buffer: grown.subarray(0, needed()),
            width: wBuf.readUInt32LE(0),
            height: hBuf.readUInt32LE(0),
            channels: cBuf.readUInt32LE(0),
          }
        : failed(rc);
    },
  };
}
