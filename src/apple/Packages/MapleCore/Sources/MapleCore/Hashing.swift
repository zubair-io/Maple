// src/apple/Packages/MapleCore/Sources/MapleCore/Hashing.swift
//
// BLAKE3-256 hex wrapper backed by raw-ffi's maple_blake3_hex.
//
// Used for `maple_id` derivation on the device-side PhotoKit backup path so
// the hash algorithm matches the rest of the Maple stack (raw-core uses
// BLAKE3 for all maple_id computation). Replaces the CryptoKit SHA-256
// stop-gap that was in PhotoKitAssetReader while the FFI symbol was missing.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §16.

import Foundation
import RawPipeline

/// BLAKE3-256 hex (64 chars) of arbitrary bytes. Backed by raw-ffi's
/// maple_blake3_hex. Used for `maple_id` derivation on the device-side
/// PhotoKit backup path so the hash algorithm matches the rest of the
/// Maple stack.
public enum BLAKE3 {
    /// Returns the 64-character lowercase hex digest of `data`, or `nil`
    /// if `data` is empty (matching the FFI contract of returning -2 for
    /// zero-length input).
    public static func hex(_ data: Data) -> String? {
        guard !data.isEmpty else { return nil }
        var out = [UInt8](repeating: 0, count: 64)
        let rc = data.withUnsafeBytes { (ptr: UnsafeRawBufferPointer) -> Int32 in
            guard let base = ptr.baseAddress else { return -1 }
            return maple_blake3_hex(
                base.assumingMemoryBound(to: UInt8.self),
                ptr.count,
                &out)
        }
        guard rc == 0 else { return nil }
        return String(bytes: out, encoding: .utf8)
    }
}
