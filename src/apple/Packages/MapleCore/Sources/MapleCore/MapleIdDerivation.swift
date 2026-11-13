// src/apple/Packages/MapleCore/Sources/MapleCore/MapleIdDerivation.swift
//
// Shared maple_id derivation orchestration (#1995) for the local-folder
// browsing sources (FilesystemSource, SMBSource). Both need the identical
// "try primary form, fall back to streaming the whole file" sequence; only
// the I/O primitive underneath differs (a chunked `FileHandle` read loop for
// local files, a chunked AMSMB2 range-read loop for SMB). Factoring the
// sequence out here means that difference is the ONLY thing each source's
// own code has to supply.

import Foundation

public enum MapleIdDerivation {

    /// The capture date the server's `readExif` stamps on this file
    /// (`captured_at`), as the ISO 8601 string the primary form hashes — or
    /// `nil` when the server would stamp none, which selects the fallback
    /// form. Every maple_id derivation (Filesystem, SMB, PhotoKit backup,
    /// agent browse) takes its date from here so a file gets one id wherever
    /// it is read.
    ///
    /// A file whose extension is in `SidecarPath.videoExtensions` is dated
    /// from its QuickTime `moov` atom (`VideoCaptureDate`) and never from
    /// EXIF, as `readExif`'s `VIDEO_EXTS` branch does (#5079). Any other file
    /// is dated by `ExifCaptureDate.capturedAt` over the raw EXIF tag strings
    /// `RawExifDates` reads from its bytes — not ImageIO's dictionary, which
    /// rewrites or drops strings the server's exifr hands over verbatim (#5090).
    ///
    /// Throws what `reader` throws: a transient read failure must surface so
    /// the caller derives no id, not a fallback id that would then be cached.
    public static func capturedAt(
        fileExtension: String,
        reader: ByteRangeReader
    ) async throws -> String? {
        if SidecarPath.videoExtensions.contains(fileExtension.lowercased()) {
            return try await VideoCaptureDate.iso8601UTC(from: reader)
        }
        let dates = try await RawExifDates.read(from: reader)
        return ExifCaptureDate.capturedAt(
            dateTimeOriginal: dates.dateTimeOriginal, createDate: dates.createDate)
    }

    /// Derive a maple_id for a file given its first-64KB head bytes, its
    /// capture date (`capturedAt(fileExtension:reader:)`), and a
    /// chunked reader over the file's full bytes for the fallback-form path.
    ///
    /// Tries primary form first, dated by `capturedAtISO8601`.
    /// `cameraSerial`/`shutterCount` are deliberately NOT read from EXIF and
    /// passed as the `MapleId.primary` defaults (`nil`/`0`) — the server
    /// indexer's `AssetExif` doesn't surface those fields either (see
    /// `MapleId.primary`'s doc comment), so reading them here would only
    /// make Apple's id diverge from the server's for the same file, not
    /// converge.
    ///
    /// Falls back to streaming form when there is no capture timestamp
    /// (`capturedAtISO8601` is `nil`) OR when primary-form derivation itself
    /// fails (empty head bytes, FFI error) — streams the WHOLE file through
    /// `FallbackFormHasher` via `nextChunk`, called repeatedly **in file
    /// order** until it returns empty `Data`, signalling EOF. Callers
    /// (`FilesystemSource` via chunked `FileHandle` reads, `SMBSource` via
    /// chunked AMSMB2 range reads or its native `AsyncThrowingStream`
    /// range-read API) supply their own bounded I/O so the whole file is
    /// never materialised as one buffer.
    ///
    /// Returns `nil` only when the fallback-form path's
    /// `FallbackFormHasher.finalize(filesize:)` itself fails (an FFI/
    /// allocation error) — NOT for an empty or unreadable-past-the-head
    /// file. Zero `nextChunk` bytes (an empty file, or a file that never
    /// yields beyond an empty `headBytes`) is a legitimate input to the
    /// fallback form: `finalize` still succeeds and returns a real id
    /// computed over zero content bytes (see `Hashing.swift`'s
    /// `FallbackFormHasher.finalize` doc and this type's own tests, which
    /// codify that an empty file gets a valid, deterministic fallback-form
    /// id rather than `nil`).
    public static func derive(
        headBytes: Data,
        capturedAtISO8601: String?,
        filesize: UInt64,
        nextChunk: () async throws -> Data
    ) async rethrows -> String? {
        if let capturedAtISO8601,
           let primary = MapleId.primary(headBytes: headBytes, capturedAtISO8601: capturedAtISO8601) {
            return primary
        }

        let hasher = FallbackFormHasher()
        while true {
            let chunk = try await nextChunk()
            if chunk.isEmpty { break }
            hasher.update(chunk)
        }
        return hasher.finalize(filesize: filesize)
    }
}
