// CloudThumbTile.swift — reusable cloud-thumbnail loader/render.
//
// Extracts the cache→client thumb fetch + ThumbnailImage render that
// CloudTimelineCell uses (CloudTimelineView.swift), so the S7 phone Search
// results can show real cloud thumbnails instead of the grey placeholder.
// Parameterised by the same (thumbClient, thumbCache, host, absPath) tuple
// the timeline cells use.

import SwiftUI
import MapleCore

/// Bundles everything a Search result cell needs to fetch a cloud thumbnail.
/// A nil context at a call site means "no live cloud session" → render the
/// neutral placeholder (keeps `#Preview`s and shell-mode usable).
struct SearchThumbContext {
    let client: CloudThumbClient
    let cache: CloudThumbCache
    let host: String
}

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

/// Cloud thumbnail view. Loads on attachment via `.task(id:)`, renders
/// `ThumbnailImage` (the same JPEG-bytes renderer BrowseGrid / Timeline use),
/// and shows a neutral placeholder until bytes arrive. The caller imposes
/// size / aspect / clipping.
struct CloudThumbTile: View {
    let absPath: String
    let thumbClient: CloudThumbClient
    let thumbCache: CloudThumbCache
    let host: String
    var displayMode: GridDisplayMode = .fill

    /// Decoded thumbnail bitmap, produced off the main actor in the `.task`.
    @State private var decoded: CGImage?

    var body: some View {
        ThumbnailImage(image: decoded ?? ThumbnailDecoder.cachedImage(forKey: absPath),
                       displayMode: displayMode)
            .task(id: absPath) {
                let bytes = await fetchCloudThumbBytes(
                    host: host, absPath: absPath, cache: thumbCache, client: thumbClient)
                guard !Task.isCancelled else { return }
                // Decode off-main, keyed on the lightweight abs-path; no arrival
                // fade (it hitches scroll — see PhotoThumbnailCell).
                let image = await ThumbnailDecoder.image(for: bytes, key: absPath)
                guard !Task.isCancelled else { return }
                decoded = image
            }
    }
}
