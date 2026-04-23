/**
 * Bun FFI wrapper for libraw_ffi.dylib (macOS) / libraw_ffi.so (Linux).
 *
 * The shared library must be present at:
 *   src/maple-self-hosted/native/libraw_ffi.dylib  (macOS)
 *   src/maple-self-hosted/native/libraw_ffi.so     (Linux)
 *
 * Build it with: bun run scripts/build-raw-ffi.sh
 *
 * If the library is not present, tryGetRawFfi() returns null and all
 * callers degrade gracefully (thumbs are skipped).
 */

import * as path from "node:path";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// C struct layout for MapleImageBuffer (must match raw-ffi/src/lib.rs)
//
//   struct MapleImageBuffer {
//     rgb:    *mut u8   (8 bytes on 64-bit)
//     len:    usize     (8 bytes)
//     width:  u32       (4 bytes)
//     height: u32       (4 bytes)
//   }
//   Total: 24 bytes
// ---------------------------------------------------------------------------

const IMAGE_BUFFER_SIZE = 24;

interface RgbResult {
  data: Uint8Array;
  width: number;
  height: number;
}

interface RawFfi {
  renderToRgb(rawAbsPath: string): RgbResult | null;
}

let _ffi: RawFfi | null | undefined = undefined; // undefined = not yet attempted

/** Returns the FFI wrapper, or null if the native library is unavailable. */
export function tryGetRawFfi(): RawFfi | null {
  if (_ffi !== undefined) return _ffi;
  _ffi = loadFfi();
  return _ffi;
}

function nativeLibPath(): string {
  const dir = path.join(
    import.meta.dir, // src/ffi/
    "..",            // src/
    "..",            // maple-self-hosted/
    "native"
  );
  const libName = process.platform === "darwin"
    ? "libraw_ffi.dylib"
    : "libraw_ffi.so";
  return path.join(dir, libName);
}

function loadFfi(): RawFfi | null {
  const libPath = nativeLibPath();

  if (!fs.existsSync(libPath)) {
    console.warn(
      `[raw-ffi] native library not found at "${libPath}". ` +
        "RAW thumbnail generation will be skipped. " +
        "Run scripts/build-raw-ffi.sh to build it."
    );
    return null;
  }

  try {
    const { dlopen, FFIType, ptr, toBuffer } = require("bun:ffi") as typeof import("bun:ffi");

    const lib = dlopen(libPath, {
      maple_render_file: {
        args: [
          FFIType.cstring,  // raw_path
          FFIType.cstring,  // xmp_path (nullable)
          FFIType.ptr,      // out: *mut MapleImageBuffer
        ],
        returns: FFIType.i32,
      },
      maple_free_buffer: {
        args: [FFIType.ptr], // *mut MapleImageBuffer
        returns: FFIType.void,
      },
      maple_last_error: {
        args: [],
        returns: FFIType.cstring,
      },
    });

    return {
      renderToRgb(rawAbsPath: string): RgbResult | null {
        // Allocate output struct on the heap (24 bytes, zero-filled).
        const outBuf = Buffer.alloc(IMAGE_BUFFER_SIZE, 0);
        const outPtr = ptr(outBuf);

        const rawPathBuf = Buffer.from(rawAbsPath + "\0", "utf-8");

        const rc = lib.symbols.maple_render_file(
          ptr(rawPathBuf),
          null,   // no XMP path — use default adjustments
          outPtr
        ) as number;

        if (rc !== 0) {
          const errStr = lib.symbols.maple_last_error() as unknown as string | null;
          console.error(`[raw-ffi] maple_render_file returned ${rc}: ${errStr}`);
          return null;
        }

        // Read struct fields from outBuf.
        // Layout (little-endian 64-bit):
        //   offset 0:  rgb pointer  (BigUint64)
        //   offset 8:  len          (BigUint64)
        //   offset 16: width        (Uint32)
        //   offset 20: height       (Uint32)
        const rgbPtrVal = Number(outBuf.readBigUInt64LE(0));
        const lenVal = Number(outBuf.readBigUInt64LE(8));
        const width = outBuf.readUInt32LE(16);
        const height = outBuf.readUInt32LE(20);

        // Copy pixel data into a JS-owned buffer.
        const rgbBuf = toBuffer(rgbPtrVal as unknown as Parameters<typeof toBuffer>[0], lenVal);
        const copy = Buffer.from(rgbBuf);

        // Free the native buffer.
        lib.symbols.maple_free_buffer(outPtr);

        return { data: copy, width, height };
      },
    };
  } catch (err) {
    console.error(
      "[raw-ffi] failed to load native library:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
