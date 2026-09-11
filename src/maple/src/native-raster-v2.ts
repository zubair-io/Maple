/**
 * Second-generation raster bindings: one general render entry point (fit,
 * filter, orientation, format, quality, AVIF effort), the same from
 * caller-supplied pixels, and a native-size RGB8 decode. Split out of
 * `native.ts` to keep that file under the repo's file-size budget — see
 * `raw-pipeline/raw-ffi/src/raster_v2.rs` for the C ABI these bind against.
 */

export interface RasterV2Binding {
  rasterRenderBuf(
    inputBytes: Uint8Array,
    width: number,
    height: number,
    flags: number,
    filter: number,
    format: string | null,
    quality: number,
    effort: number,
  ): { ok: boolean; buffer?: Buffer; error?: string };

  rasterFromRawRenderBuf(
    pixels: Uint8Array,
    srcWidth: number,
    srcHeight: number,
    channels: number,
    width: number,
    height: number,
    flags: number,
    filter: number,
    format: string | null,
    quality: number,
    effort: number,
  ): { ok: boolean; buffer?: Buffer; error?: string };

  rasterDecodeRgb8Buf(
    inputBytes: Uint8Array,
    autoOrient: boolean,
  ): { ok: boolean; buffer?: Buffer; width?: number; height?: number; error?: string };
}

/** Build the raster-v2 methods, closing over the caller's `dlopen` handle. */
export function createRasterV2Binding(
  lib: { symbols: Record<string, (...args: unknown[]) => unknown> },
  ptr: (buf: Uint8Array) => unknown,
  getLastError: () => string | null,
): RasterV2Binding {
  return {
    rasterRenderBuf(inputBytes, width, height, flags, filter, format, quality, effort) {
      const fmtBuf = format ? Buffer.from(format + '\0', 'utf-8') : null;
      const outLenBuf = Buffer.alloc(8);
      const call = (outBuf: Buffer) =>
        lib.symbols.maple_raster_render_buf(
          ptr(inputBytes),
          BigInt(inputBytes.byteLength),
          width >>> 0,
          height >>> 0,
          flags >>> 0,
          filter >>> 0,
          fmtBuf ? ptr(fmtBuf) : null,
          quality & 0xff,
          effort & 0xff,
          ptr(outBuf),
          BigInt(outBuf.byteLength),
          ptr(outLenBuf),
        ) as number;
      const first = Buffer.alloc(Math.max(65536, inputBytes.byteLength * 2));
      const rc0 = call(first);
      const outBuf = rc0 === 100 ? Buffer.alloc(Number(outLenBuf.readBigUInt64LE(0))) : first;
      const rc = rc0 === 100 ? call(outBuf) : rc0;
      if (rc !== 0) {
        return { ok: false, error: getLastError() || `Raster render failed with code ${rc}` };
      }
      return { ok: true, buffer: outBuf.subarray(0, Number(outLenBuf.readBigUInt64LE(0))) };
    },

    rasterFromRawRenderBuf(
      pixels,
      srcWidth,
      srcHeight,
      channels,
      width,
      height,
      flags,
      filter,
      format,
      quality,
      effort,
    ) {
      const fmtBuf = format ? Buffer.from(format + '\0', 'utf-8') : null;
      const outLenBuf = Buffer.alloc(8);
      const call = (outBuf: Buffer) =>
        lib.symbols.maple_raster_from_raw_render_buf(
          ptr(pixels),
          BigInt(pixels.byteLength),
          srcWidth >>> 0,
          srcHeight >>> 0,
          channels >>> 0,
          width >>> 0,
          height >>> 0,
          flags >>> 0,
          filter >>> 0,
          fmtBuf ? ptr(fmtBuf) : null,
          quality & 0xff,
          effort & 0xff,
          ptr(outBuf),
          BigInt(outBuf.byteLength),
          ptr(outLenBuf),
        ) as number;
      const first = Buffer.alloc(Math.max(65536, pixels.byteLength));
      const rc0 = call(first);
      const outBuf = rc0 === 100 ? Buffer.alloc(Number(outLenBuf.readBigUInt64LE(0))) : first;
      const rc = rc0 === 100 ? call(outBuf) : rc0;
      if (rc !== 0) {
        return { ok: false, error: getLastError() || `Raw raster render failed with code ${rc}` };
      }
      return { ok: true, buffer: outBuf.subarray(0, Number(outLenBuf.readBigUInt64LE(0))) };
    },

    rasterDecodeRgb8Buf(inputBytes, autoOrient) {
      const outLenBuf = Buffer.alloc(8);
      const wBuf = Buffer.alloc(4);
      const hBuf = Buffer.alloc(4);
      const call = (outBuf: Buffer | null) =>
        lib.symbols.maple_raster_decode_rgb8_buf(
          ptr(inputBytes),
          BigInt(inputBytes.byteLength),
          autoOrient ? 1 : 0,
          outBuf ? ptr(outBuf) : null,
          BigInt(outBuf ? outBuf.byteLength : 0),
          ptr(outLenBuf),
          ptr(wBuf),
          ptr(hBuf),
        ) as number;
      const rc0 = call(null);
      if (rc0 !== 100) {
        return { ok: false, error: getLastError() || `RGB8 decode failed with code ${rc0}` };
      }
      const outBuf = Buffer.alloc(Number(outLenBuf.readBigUInt64LE(0)));
      const rc = call(outBuf);
      if (rc !== 0) {
        return { ok: false, error: getLastError() || `RGB8 decode failed with code ${rc}` };
      }
      return {
        ok: true,
        buffer: outBuf,
        width: wBuf.readUInt32LE(0),
        height: hBuf.readUInt32LE(0),
      };
    },
  };
}
