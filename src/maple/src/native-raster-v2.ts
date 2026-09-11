/**
 * Second-generation raster bindings: one general render entry point (fit,
 * filter, orientation, format, quality, AVIF effort), the same from
 * caller-supplied pixels, and a native-size RGB8 decode. Split out of
 * `native.ts` to keep that file under the repo's file-size budget — see
 * `raw-pipeline/raw-ffi/src/raster_v2.rs` for the C ABI these bind against.
 */

/** rc from the C ABI for "your buffer was too small; `*out_len` is the size". */
const NEED_LARGER_BUFFER = 100;

/**
 * Ceiling on the pixel count `rasterDecodeRgb8Buf` will allocate for straight
 * from a header, matching raw-core's `AVIF_MAX_FRAME_PIXELS`. The dimensions
 * come from the file's own header, before any decoder has validated it, so
 * without a ceiling a hostile TIFF/PNG declaring 100000x100000 would turn a
 * documented `{ ok: false, error }` into a `RangeError` thrown out of
 * `Buffer.alloc`. Past the ceiling the code takes the null-buffer size probe
 * instead, which allocates nothing until the decoder agrees on a size.
 */
const MAX_PROBE_SIZED_PIXELS = 268_000_000;

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

/**
 * Bytes of interleaved RGB8 the decode will produce, from the header probe
 * alone, or 0 when the probe can't be trusted to size the allocation — an
 * unreadable header, dimensions past `MAX_PROBE_SIZED_PIXELS`, or a RAW file,
 * which probes fine through the TIFF dimension parser but has no path through
 * this decoder at all (so sizing a 100 MP buffer for it would allocate ~300 MB
 * only to fail). A 0 sends the caller to the null-buffer size probe, which
 * allocates nothing on the way to the same answer.
 *
 * EXIF orientations 5-8 swap the reported dimensions under `rotate()` but not
 * the byte count; the swap is spelled out anyway so the sizing reads the same
 * way the decoder does.
 */
function rgb8SizeFromProbe(probe: RasterMetadataProbe, autoOrient: boolean): number {
  const meta = probe.ok ? probe.metadata : undefined;
  if (!meta || meta.width <= 0 || meta.height <= 0 || meta.format === 'dng') {
    return 0;
  }
  if (meta.width * meta.height > MAX_PROBE_SIZED_PIXELS) {
    return 0;
  }
  const swapped = autoOrient && meta.orientation >= 5 && meta.orientation <= 8;
  const width = swapped ? meta.height : meta.width;
  const height = swapped ? meta.width : meta.height;
  return width * height * 3;
}

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

/**
 * Build the raster-v2 methods, closing over the caller's `dlopen` handle.
 * `probeMetadata` is the header probe from `native.ts`; `rasterDecodeRgb8Buf`
 * uses it to size its output so the image is decoded once, not twice.
 */
export function createRasterV2Binding(
  lib: { symbols: Record<string, (...args: unknown[]) => unknown> },
  ptr: (buf: Uint8Array) => unknown,
  getLastError: () => string | null,
  probeMetadata: (inputBytes: Uint8Array) => RasterMetadataProbe,
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
      const outBuf =
        rc0 === NEED_LARGER_BUFFER ? Buffer.alloc(Number(outLenBuf.readBigUInt64LE(0))) : first;
      const rc = rc0 === NEED_LARGER_BUFFER ? call(outBuf) : rc0;
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
      const outBuf =
        rc0 === NEED_LARGER_BUFFER ? Buffer.alloc(Number(outLenBuf.readBigUInt64LE(0))) : first;
      const rc = rc0 === NEED_LARGER_BUFFER ? call(outBuf) : rc0;
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
      const needed = () => Number(outLenBuf.readBigUInt64LE(0));
      const failed = (rc: number) => ({
        ok: false,
        error: getLastError() || `RGB8 decode failed with code ${rc}`,
      });
      const decoded = (outBuf: Buffer) => ({
        ok: true,
        buffer: outBuf.subarray(0, needed()),
        width: wBuf.readUInt32LE(0),
        height: hBuf.readUInt32LE(0),
      });
      // Sizing the buffer from the cheap header probe keeps this to a single
      // decode. Calling with a null buffer also reports the size, but it runs
      // the whole decode + orient + rgb8 conversion in Rust to do it, so the
      // null probe is only the fallback for an input the probe cannot size (or
      // sizes short, e.g. a header that disagrees with the payload).
      const sized = rgb8SizeFromProbe(probeMetadata(inputBytes), autoOrient);
      if (sized > 0) {
        const outBuf = Buffer.alloc(sized);
        const rc = call(outBuf);
        if (rc === 0) {
          return decoded(outBuf);
        }
        if (rc !== NEED_LARGER_BUFFER) {
          return failed(rc);
        }
        const grown = Buffer.alloc(needed());
        const rcGrown = call(grown);
        return rcGrown === 0 ? decoded(grown) : failed(rcGrown);
      }
      const rc0 = call(null);
      if (rc0 !== NEED_LARGER_BUFFER) {
        return failed(rc0);
      }
      const outBuf = Buffer.alloc(needed());
      const rc = call(outBuf);
      return rc === 0 ? decoded(outBuf) : failed(rc);
    },
  };
}
