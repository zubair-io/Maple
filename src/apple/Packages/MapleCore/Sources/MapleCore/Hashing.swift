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
                UInt(ptr.count),
                &out)
        }
        guard rc == 0 else { return nil }
        return String(bytes: out, encoding: .utf8)
    }
}

/// Spec-form `maple_id` derivation matching the server indexer
/// (`src/api/src/indexer/id.ts`) and the Rust reference at
/// `src/raw-pipeline/raw-core/src/id.rs`. Output is the 32-character
/// lowercase hex of the 16-byte tagged id — the exact wire format the
/// server's backup-ingest path uses as a dedup key.
///
/// The device-side backup path was previously sending a 64-char raw
/// BLAKE3 over full bytes, which never matched the indexer's
/// `findOne({ maple_id })` lookup. Switching to this derivation makes the
/// `(server-indexed file, device backup)` pair dedup end-to-end.
public enum MapleId {
    /// Primary form (`tag 0x01`). Hashes only the first 64 KB of
    /// `headBytes` per spec — callers may pass exactly the leading 64 KB
    /// rather than the entire file. `capturedAtISO8601` is hashed
    /// verbatim; pass the same string the server's indexer normalises EXIF
    /// DateTimeOriginal to (ISO 8601 with millisecond precision, UTC).
    /// `cameraSerial = nil` and `shutterCount = 0` both match the
    /// indexer's current default behaviour (it passes `null` for both
    /// because `AssetExif` doesn't surface them yet).
    public static func primary(
        headBytes: Data,
        capturedAtISO8601: String,
        cameraSerial: String? = nil,
        shutterCount: UInt64 = 0
    ) -> String? {
        guard !headBytes.isEmpty, !capturedAtISO8601.isEmpty else { return nil }
        let tsBytes = Data(capturedAtISO8601.utf8)
        let serialBytes: Data? = cameraSerial.map { Data($0.utf8) }
        var out = [UInt8](repeating: 0, count: 32)
        let rc = headBytes.withUnsafeBytes { (head: UnsafeRawBufferPointer) -> Int32 in
            tsBytes.withUnsafeBytes { (ts: UnsafeRawBufferPointer) -> Int32 in
                let call: (UnsafePointer<UInt8>?, UInt) -> Int32 = { sPtr, sLen in
                    guard let headBase = head.baseAddress, let tsBase = ts.baseAddress else { return -1 }
                    return maple_id_primary(
                        headBase.assumingMemoryBound(to: UInt8.self),
                        UInt(head.count),
                        tsBase.assumingMemoryBound(to: UInt8.self),
                        UInt(ts.count),
                        sPtr,
                        sLen,
                        shutterCount,
                        &out)
                }
                if let serialBytes {
                    return serialBytes.withUnsafeBytes { (s: UnsafeRawBufferPointer) -> Int32 in
                        guard let sBase = s.baseAddress else { return call(nil, 0) }
                        return call(sBase.assumingMemoryBound(to: UInt8.self), UInt(s.count))
                    }
                } else {
                    return call(nil, 0)
                }
            }
        }
        guard rc == 0 else { return nil }
        return String(bytes: out, encoding: .utf8)
    }

    /// Fallback form (`tag 0x02`). Hashes the entire `bytes` slice plus
    /// the file size. Used when capture date is unavailable — e.g. screen
    /// recordings, scanner output, files whose EXIF was stripped.
    public static func fallback(bytes: Data) -> String? {
        guard !bytes.isEmpty else { return nil }
        var out = [UInt8](repeating: 0, count: 32)
        let rc = bytes.withUnsafeBytes { (ptr: UnsafeRawBufferPointer) -> Int32 in
            guard let base = ptr.baseAddress else { return -1 }
            return maple_id_fallback(
                base.assumingMemoryBound(to: UInt8.self),
                UInt(ptr.count),
                UInt64(ptr.count),
                &out)
        }
        guard rc == 0 else { return nil }
        return String(bytes: out, encoding: .utf8)
    }
}
