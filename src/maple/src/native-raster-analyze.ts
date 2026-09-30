/**
 * `bun:ffi` wrappers for `maple_raster_analyze_buf` and `_path` — the read-only half of
 * the raster surface (#3507). JSON request in, JSON reply out; see
 * `raw-pipeline/raw-core/src/raster_analyze.rs` for the schema.
 */

/** rc from the C ABI for "your buffer was too small; `*out_len` is the size". */
const NEED_LARGER_BUFFER = 100;

/**
 * Upper bound on the second-pass allocation `*out_len` drives. The Rust side
 * already caps each sidecar block it will return at 16 MiB
 * (`raster_meta.rs`'s `MAX_SIDECAR_BYTES`), so a reply carrying every field
 * (icc + exif + xmp, each base64'd to ~1.34x, plus stats) comfortably fits
 * well under this; a `*out_len` above it means a corrupt reply or a hostile
 * native layer, not a legitimate image.
 */
const MAX_ANALYZE_REPLY_BYTES = 64 * 1024 * 1024;

export interface RasterAnalyzeBinding {
  rasterAnalyzePath(
    inputPath: string,
    requestJson: string,
  ): { ok: boolean; json?: string; error?: string };
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
  // Both entry points use the same caller-owned JSON reply buffer contract.
  const reply = (invoke: (out: Buffer, outLen: Buffer) => number) => {
    const outLen = Buffer.alloc(8);
    const needed = () => Number(outLen.readBigUInt64LE(0));
    const first = Buffer.alloc(65536);
    const rc0 = invoke(first, outLen);
    if (rc0 === 0) {
      return { ok: true, json: first.subarray(0, needed()).toString('utf-8') };
    }
    if (rc0 !== NEED_LARGER_BUFFER) {
      return { ok: false, error: getLastError() || `Analyze failed with code ${rc0}` };
    }
    if (needed() > MAX_ANALYZE_REPLY_BYTES) {
      return {
        ok: false,
        error: `Analyze reply of ${needed()} bytes exceeds the ${MAX_ANALYZE_REPLY_BYTES}-byte limit`,
      };
    }
    const grown = Buffer.alloc(needed());
    const rc = invoke(grown, outLen);
    return rc === 0
      ? { ok: true, json: grown.subarray(0, needed()).toString('utf-8') }
      : { ok: false, error: getLastError() || `Analyze failed with code ${rc}` };
  };
  return {
    rasterAnalyzeBuf(input, requestJson) {
      const requestBuf = Buffer.from(requestJson + '\0', 'utf-8');
      return reply(
        (out, outLen) =>
          lib.symbols.maple_raster_analyze_buf(
            ptr(input),
            BigInt(input.byteLength),
            ptr(requestBuf),
            ptr(out),
            BigInt(out.byteLength),
            ptr(outLen),
          ) as number,
      );
    },
    rasterAnalyzePath(inputPath, requestJson) {
      if (inputPath.includes('\0')) return { ok: false, error: 'input_path contains a NUL byte' };
      const pathBuf = Buffer.from(inputPath + '\0', 'utf-8');
      const requestBuf = Buffer.from(requestJson + '\0', 'utf-8');
      return reply(
        (out, outLen) =>
          lib.symbols.maple_raster_analyze_path(
            ptr(pathBuf),
            ptr(requestBuf),
            ptr(out),
            BigInt(out.byteLength),
            ptr(outLen),
          ) as number,
      );
    },
  };
}
