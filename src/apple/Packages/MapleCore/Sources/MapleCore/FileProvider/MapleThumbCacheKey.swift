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

import CoreGraphics
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

    // MARK: - On-share render contract (#2690)
    //
    // Any client that WRITES to the shared `.maple/thumbs/<hash>.avif`
    // path (not just reads it) must render at exactly these parameters.
    // The API's thumbnailer (`src/api/src/thumbs/render.ts`) guards
    // re-render by mtime freshness — once an entry exists, a fresher
    // write at the WRONG size/quality permanently downgrades that entry
    // for every other client (Web, other Mac/iOS sessions, the indexer
    // itself) with no self-healing re-render to correct it. So this is
    // not a local preference, it is the cross-layer contract.
    //
    // Not code-generated: `tools/codegen.sh`'s pipeline sources exclusively
    // from `raw-core` Rust canonical constants (color matrices, adjustment
    // schema, UI tokens); `THUMB_LONG_EDGE_PX`/`THUMB_AVIF_QUALITY` are
    // TypeScript-native to the Bun API layer, outside that pipeline's
    // scope, so wiring a fourth codegen target for two integers is not
    // justified by this ticket. Duplicated as literals instead, with
    // `MapleThumbCacheKeyTests.testOnShareRenderContractMatchesTheAPI`
    // pinning them against the actual values read out of
    // `src/api/src/thumbs/render.ts` — a drift in either file fails that
    // test, unlike a silent literal with no pin at all.

    /// Long edge, in pixels, an on-share write MUST render at. Mirrors
    /// `THUMB_LONG_EDGE_PX` in `src/api/src/thumbs/render.ts`.
    public static let onShareThumbLongEdgePx: CGFloat = 512

    /// AVIF quality (ImageIO's 0...1 lossy scale) an on-share write MUST
    /// render at. Mirrors `THUMB_AVIF_QUALITY` (55, on the API's 0...100
    /// sharp/libavif scale) in `src/api/src/thumbs/render.ts` — 55/100 ==
    /// 0.55 on the 0...1 scale ImageIO/`ThumbnailEncoder.encode` takes.
    public static let onShareThumbAVIFQuality: CGFloat = 0.55
}
