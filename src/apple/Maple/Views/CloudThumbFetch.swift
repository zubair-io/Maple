// CloudThumbFetch.swift — shared cloud-thumbnail byte fetch.
//
// Cache→client thumb fetch extracted from CloudTimelineCell
// (CloudTimelineView.swift). Used by the Map's thumbnail pins
// (MapAnnotationContent). The `CloudThumbTile` view that used to live
// alongside it was removed with the S7 top-hits section in the unified
// search redesign (#2866).

import Foundation
import MapleCore

/// Thumb bytes for a cloud photo: the cache first, then the network client,
/// whose answer is stored. Nil when neither has it, so the caller renders the
/// placeholder; while the server is unreachable a stored older rendering is
/// returned instead (`CloudThumbCache.bytes`).
func fetchCloudThumbBytes(
    host: String,
    absPath: String,
    version: String? = nil,
    cache: CloudThumbCache,
    client: CloudThumbClient
) async -> Data? {
    await cache.bytes(host: host, absPath: absPath, version: version) {
        try await client.thumb(absPath: absPath, version: version)
    }
}
