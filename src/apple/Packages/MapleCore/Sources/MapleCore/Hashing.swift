// src/apple/Packages/MapleCore/Sources/MapleCore/Hashing.swift
//
// BLAKE3-256 hex wrapper backed by raw-ffi's maple_blake3_hex.
//
// Used for `maple_id` derivation on the device-side PhotoKit backup path so
// the hash algorithm matches the rest of the Maple stack (raw-core uses
// BLAKE3 for all maple_id computation). Replaces the CryptoKit SHA-256
// stop-gap that was in PhotoKitAssetReader while the FFI symbol was missing.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §16.

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

// MARK: - FallbackFormHasher (streaming fallback-form id hasher, #1995)

/// Owns a Rust-allocated streaming fallback-form id hasher
/// (`raw_core::FallbackIdHasher` via the opaque `maple_fallback_id_hasher_*`
/// FFI entries in `raw-ffi/src/id.rs`). Lets a caller feed a file's bytes in
/// bounded chunks — an SMB byte-range read loop (`SMBSource`), a chunked
/// `FileHandle` read loop (`FilesystemSource`) — without ever holding the
/// whole file as one `Data` buffer, which is the entire point of this type:
/// `MapleId.fallback(bytes:)` requires the full file already resident as a
/// single contiguous slice, the wrong shape for a 100+ MB RAW streamed in
/// pieces.
///
/// Chunking never changes the result: any sequence of `update(_:)` calls
/// that covers the same bytes in the same order as a single
/// `MapleId.fallback(bytes:)` call over the whole buffer produces a
/// byte-identical hex id — guaranteed by the Rust reference's own chunking
/// tests (`raw-core/src/id.rs`'s `fallback_id_hasher_matches_one_shot_*`
/// suite) and re-verified from the Swift side by
/// `HashingTests.testFallbackFormHasherMatchesOneShotForSmallBuffer`, which
/// proves this wrapper reproduces `MapleId.fallback`'s output for an
/// in-memory buffer independent of how it's chunked.
///
/// Lifecycle: `init()` (never fails to allocate — matches
/// `maple_fallback_id_hasher_new`, which never returns null), any number of
/// `update(_:)` calls **in file order**, then exactly one of:
///   - `finalize(filesize:)` — consumes the handle, returns the 32-char
///     lowercase hex fallback-form id (or `nil` on an FFI-reported error).
///   - letting the instance deinit without ever calling `finalize` — the
///     early-abort path (e.g. the caller cancelled a chunked read partway
///     through); `deinit` frees the Rust allocation via
///     `maple_fallback_id_hasher_free` so an abandoned hash never leaks the
///     native allocation.
/// Calling `update`/`finalize` again after `finalize` has already run is a
/// silent no-op (the handle is nil'd out at that point) rather than a crash
/// — defensive, not a documented supported path; callers should not do
/// this regardless.
public final class FallbackFormHasher {
    /// Pointer to the Rust-side hasher state. `UnsafeMutablePointer` (not
    /// `OpaquePointer`) because cbindgen emits `MapleFallbackIdHasher` as an
    /// actual (if single-field) `#[repr(C)]` C struct rather than a forward
    /// declaration — same shape and same Swift-side handling as
    /// `MapleRawHandle` (`PipelineRenderer.swift`) and `MapleCancelFlag`
    /// (`RenderCancelFlag.swift`); see the latter's doc comment for the full
    /// explanation of why this isn't `OpaquePointer`.
    private var pointer: UnsafeMutablePointer<MapleFallbackIdHasher>?

    public init() {
        self.pointer = maple_fallback_id_hasher_new()
    }

    /// Feed the next chunk of file bytes, **in file order**. Chunk length is
    /// caller-defined and may vary call to call, including zero (a no-op —
    /// matches `raw_core::FallbackIdHasher::update`'s empty-chunk
    /// contract). Silently does nothing once `finalize` has already
    /// consumed this hasher, or if allocation failed at `init`.
    public func update(_ chunk: Data) {
        guard let pointer else { return }
        if chunk.isEmpty {
            _ = maple_fallback_id_hasher_update(pointer, nil, 0)
            return
        }
        chunk.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            guard let base = buf.baseAddress else { return }
            _ = maple_fallback_id_hasher_update(
                pointer,
                base.assumingMemoryBound(to: UInt8.self),
                UInt(buf.count))
        }
    }

    /// Finish the hash and return the 32-character lowercase hex
    /// fallback-form id. Consumes the handle — `update`/`finalize` become
    /// no-ops on any subsequent call. Returns `nil` on an FFI error
    /// (allocation failure at `init`, or a non-zero rc from the finalize
    /// call) — same nil-on-failure idiom as `MapleId.fallback`.
    ///
    /// `filesize` mirrors `MapleId.fallback`'s contract: typically the total
    /// bytes fed via `update`, but callers may pass a different true
    /// on-disk size — the spec formula's `filesize` term is independent of
    /// the hashed byte count.
    public func finalize(filesize: UInt64) -> String? {
        guard let pointer else { return nil }
        self.pointer = nil  // consumed either way once finalize is called
        var out = [UInt8](repeating: 0, count: 32)
        let rc = maple_fallback_id_hasher_finalize(pointer, filesize, &out)
        guard rc == 0 else { return nil }
        return String(bytes: out, encoding: .utf8)
    }

    deinit {
        // Safe: `maple_fallback_id_hasher_free` is a no-op-safe single-owner
        // free. `finalize` nils `pointer` before returning, so this only
        // fires on the early-abort path (never-finalized instance).
        if let pointer {
            maple_fallback_id_hasher_free(pointer)
        }
    }
}
