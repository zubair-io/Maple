// MaskRasterRegistry.swift — Swift wrapper over the process-wide bitmap-mask
// raster registry (#3271, `maple_mask_raster_register` / `_release` in
// raw-ffi/src/mask_registry.rs). One raster (a Vision person/skin selection)
// registers here once and is referenced by its returned id from
// `Mask.bitmap(recipe:rasterId:)`; the render chain resolves that id back to
// pixels on every tick without any per-tick FFI table/plane copy.

import Foundation
import RawPipeline

public enum MaskRasterRegistry {
    /// Registers an R8 raster (row-major, `width * height` bytes, `0` =
    /// weight 0, `255` = weight 1) under a 16-lowercase-hex-char digest.
    /// Returns the id a `Mask.bitmap` record's `rasterId` resolves against,
    /// or `nil` on any rejection (null/bad-len/bad-digest) — the caller
    /// surfaces that as a thrown error rather than a silently-inert mask.
    ///
    /// Re-registering the SAME digest allocates a NEW id each call; the
    /// caller owns releasing the OLD id via `release(_:)` once nothing still
    /// references it (matching the C contract's ownership note).
    public static func register(digest: String, width: Int, height: Int, bytes: [UInt8]) -> UInt32? {
        guard digest.utf8.count == 16, width > 0, height > 0, bytes.count == width * height else {
            return nil
        }
        let digestBytes = Array(digest.utf8)
        let rc = bytes.withUnsafeBufferPointer { dataBuf -> Int32 in
            digestBytes.withUnsafeBufferPointer { digestBuf in
                maple_mask_raster_register(
                    digestBuf.baseAddress, UInt32(width), UInt32(height),
                    dataBuf.baseAddress, UInt(dataBuf.count))
            }
        }
        return rc >= 1 ? UInt32(rc) : nil
    }

    /// Releases a previously-registered raster id. A no-op-safe call on an
    /// id that is unknown or was already released (matches the C contract).
    public static func release(_ id: UInt32) {
        maple_mask_raster_release(id)
    }
}
