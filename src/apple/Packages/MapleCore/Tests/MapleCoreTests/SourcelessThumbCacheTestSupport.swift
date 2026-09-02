// SourcelessThumbCacheTestSupport.swift — #2763 (Copilot review, PR #3183).
//
// Sourceless (PhotoKit/Self-Hosted) thumbnails now persist at a FIXED
// location under the real per-user Caches directory
// (`ThumbnailDiskCache.sourcelessCacheDir`) rather than an ephemeral tmp
// dir — the whole point of the fix this ticket makes. That means a test
// key not cleaned up after itself leaves a real file behind in the
// developer's actual `~/Library/Caches/`, accumulating across every
// `swift test` run. This helper computes that same on-disk path (mirroring
// `ThumbnailDiskCache`'s own private derivation) so tests can remove their
// own artifact in `defer`/`tearDown`.

import Foundation
@testable import MapleCore

/// The on-disk path a sourceless thumbnail for `key` would be written to —
/// `~/Library/Caches/app.justmaple.aperture/sourceless-thumbs/<hash>.avif`.
/// Test-only mirror of `ThumbnailDiskCache`'s private `sourcelessCacheDir` +
/// `hashKey(_:)`; both derive from the same public
/// `MapleThumbCacheKey.sha256Prefix16(_:)`, so this stays correct without
/// needing access to the cache's own private state.
func sourcelessThumbCacheFileURL(forKey key: String) -> URL {
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
    let hashed = MapleThumbCacheKey.sha256Prefix16(key)
    return caches
        .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
        .appendingPathComponent("sourceless-thumbs", isDirectory: true)
        .appendingPathComponent("\(hashed).avif")
}

/// Removes the on-disk sourceless-thumb artifact for `key`, if any. Safe to
/// call even when nothing was ever written for that key.
func removeSourcelessThumbCacheFile(forKey key: String) {
    try? FileManager.default.removeItem(at: sourcelessThumbCacheFileURL(forKey: key))
}
