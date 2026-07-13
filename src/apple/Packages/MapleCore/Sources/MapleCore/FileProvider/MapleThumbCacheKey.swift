// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/MapleThumbCacheKey.swift
//
// Server-side `.maple/thumbs/` cache filename derivation.
//
// Mirrors the Bun server's `sha256Prefix16(basename)` (see
// `src/api/src/fs/xmp.ts` `resolveThumbPath`) and the web maple-cache's
// `sha.ts`. The on-disk filename for a RAW's pre-rendered thumbnail is:
//
//     <RAW parent>/.maple/thumbs/<sha256_prefix16(basename)>.avif
//
// The hash input is the RAW's filename (basename WITH extension), NOT
// the absolute path — so `.maple/` travels with the photos when the
// folder is copied. All three implementations (Apple, Web, API) MUST
// agree on the encoding for cross-platform thumbnail reads to work.
//
// Existing parity reference: the same hash is used in
// `Cache/ThumbnailDiskCache.swift`'s private `stableHash` helper. This
// file lifts the function into a shared, testable surface used by the
// File Provider enumerator's `.maple/thumbs/` synthesis path.

import Foundation
import CryptoKit

public enum MapleThumbCacheKey {
    /// First 16 hex chars of `SHA256(text)` — i.e. the first 8 bytes
    /// of the digest formatted as lowercase hex. Matches the Bun
    /// `sha256Prefix16` and the web Hosted variant.
    public static func sha256Prefix16(_ text: String) -> String {
        let digest = SHA256.hash(data: Data(text.utf8))
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// Compose the on-disk thumbnail filename the server would write
    /// for `rawBasename`. `rawBasename` is the RAW's filename with
    /// extension (e.g. `IMG_0001.ARW`), exactly as `path.basename`
    /// would return it server-side. Always returns `<hex>.avif`
    /// regardless of the input extension — the server normalises
    /// every cached thumb to AVIF.
    public static func thumbFilename(forRawBasename rawBasename: String) -> String {
        return "\(sha256Prefix16(rawBasename)).avif"
    }
}
