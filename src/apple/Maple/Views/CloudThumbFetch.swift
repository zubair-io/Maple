// CloudThumbFetch.swift — shared cloud-thumbnail byte fetch.
//
// Cache→client thumb fetch extracted from CloudTimelineCell
// (CloudTimelineView.swift). Used by the Map's thumbnail pins
// (MapAnnotationContent). The `CloudThumbTile` view that used to live
// alongside it was removed with the S7 top-hits section in the unified
// search redesign (#2866).

import Foundation
import MapleCore

/// Fetch JPEG thumb bytes: cache first, then the network client (populating
/// the cache on a hit). Returns nil on any error so the caller renders the
/// placeholder. Mirrors `CloudTimelineCell.fetchThumbBytes`.
func fetchCloudThumbBytes(
    host: String,
    absPath: String,
    cache: CloudThumbCache,
    client: CloudThumbClient
) async -> Data? {
    if let cached = await cache.get(host: host, absPath: absPath) {
        return cached
    }
    do {
        let bytes = try await client.thumb(absPath: absPath)
        await cache.put(host: host, absPath: absPath, bytes)
        return bytes
    } catch {
        return nil
    }
}
