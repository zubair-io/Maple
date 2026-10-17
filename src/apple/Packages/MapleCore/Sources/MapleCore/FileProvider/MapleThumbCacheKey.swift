// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/MapleThumbCacheKey.swift
//
// Shared `.maple/thumbs/` cache filename derivation.
//
// The on-disk filename for an asset's pre-rendered thumbnail is its own
// filename, extension included, plus `.avif` (#4793):
//
//     <asset parent>/.maple/thumbs/<filename.ext>.avif
//
// matching `.maple/previews/<filename.ext>.avif`, so `.maple/` travels with
// the photos when the folder is copied. API, Web, Android, Windows and Apple
// MUST agree on this name for cross-platform thumbnail reads to work.
//
// `sha256Prefix16` survives only to find the frozen legacy name
// `<sha256_prefix16(filename)>.v25.avif` that earlier builds wrote, which
// readers rename into place on a miss.

import CoreGraphics
import CryptoKit
import Foundation

public enum MapleThumbCacheKey {
  /// First 16 hex chars of `SHA256(text)` — i.e. the first 8 bytes
  /// of the digest formatted as lowercase hex. Matches the Bun
  /// `sha256Prefix16` and the web Hosted variant.
  public static func sha256Prefix16(_ text: String) -> String {
    let digest = SHA256.hash(data: Data(text.utf8))
    return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
  }

  /// `IMG_0001.ARW` → `IMG_0001.ARW.avif`. Every cached thumb is AVIF
  /// regardless of the asset's own extension.
  public static func thumbFilename(forRawBasename rawBasename: String) -> String {
    thumbFilename(forKey: rawBasename)
  }

  /// `<key>.avif` for an opaque cache key (sourceless assets).
  public static func thumbFilename(forKey key: String) -> String {
    "\(key).avif"
  }

  /// The frozen pre-#4793 name, `<sha256_prefix16(filename)>.v25.avif`.
  public static func legacyThumbFilename(forRawBasename rawBasename: String) -> String {
    legacyThumbFilename(forKey: sha256Prefix16(rawBasename))
  }

  /// The frozen pre-#4793 name for an opaque cache key, `<key>.v25.avif`.
  public static func legacyThumbFilename(forKey key: String) -> String {
    "\(key)\(MapleSidecarPaths.legacyDerivativeSuffix)"
  }

  // MARK: - On-share render contract (#2690)
  //
  // Any client that WRITES to the shared `.maple/thumbs/<filename.ext>.avif`
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
