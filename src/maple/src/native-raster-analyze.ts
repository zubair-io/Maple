/**
 * `bun:ffi` wrapper for `maple_raster_analyze_buf` — the read-only half of
 * the raster surface (#3507). JSON request in, JSON reply out; see
 * `raw-pipeline/raw-core/src/raster_analyze.rs` for the schema.
 */

/** rc from the C ABI for "your buffer was too small; `*out_len` is the size". */
const NEED_LARGER_BUFFER = 100;

export interface RasterAnalyzeBinding {
  rasterAnalyzeBuf(
    input: Uint8Array,
    requestJson: string,
  ): { ok: boolean; json?: string; error?: string };
}

export function createRasterAnalyzeBinding(
  lib: { symbols: Record<string, (...args: unknown[]) => unknown> },
  ptr: (buf: Uint8Array) => unknown,
  getLastError: () => string | null,
): RasterAnalyzeBinding {
  return {
    rasterAnalyzeBuf(input, requestJson) {
      const requestBuf = Buffer.from(requestJson + '\0', 'utf-8');
      const outLenBuf = Buffer.alloc(8);
      const call = (outBuf: Buffer | null) =>
        lib.symbols.maple_raster_analyze_buf(
          ptr(input),
          BigInt(input.byteLength),
          ptr(requestBuf),
          outBuf ? ptr(outBuf) : null,
          BigInt(outBuf ? outBuf.byteLength : 0),
          ptr(outLenBuf),
        ) as number;
      const needed = () => Number(outLenBuf.readBigUInt64LE(0));
      // An analyze reply is small unless it carries a big EXIF block; 64 KB
      // covers the common case in one call.
      const first = Buffer.alloc(65536);
      const rc0 = call(first);
      if (rc0 === 0) {
        return { ok: true, json: first.subarray(0, needed()).toString('utf-8') };
      }
      if (rc0 !== NEED_LARGER_BUFFER) {
        return { ok: false, error: getLastError() || `Analyze failed with code ${rc0}` };
      }
      const grown = Buffer.alloc(needed());
      const rc = call(grown);
      return rc === 0
        ? { ok: true, json: grown.subarray(0, needed()).toString('utf-8') }
        : { ok: false, error: getLastError() || `Analyze failed with code ${rc}` };
    },
  };
}
