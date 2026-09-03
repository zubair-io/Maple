// EditorSeedThumbnail+VM.swift — where the editor's seed thumbnail comes
// from (#2374). No SwiftUI: this is the unit-testable half of
// `EditorSeedThumbnail`, per the view-model split in pattern #192.

import CoreGraphics
import Foundation
import MapleCore
import MapleCloudKit

enum EditorSeedThumbnailVM {
    /// The asset's existing thumbnail bytes, decoded.
    ///
    /// Catalog-backed (Maple Cloud) refs read the on-disk `CloudThumbCache`
    /// the grid populated — a fresh instance points at the same shared
    /// directory. Everything else goes through the same `ThumbnailProvider`
    /// route the grid, filmstrip and Preview use. A miss simply leaves the
    /// canvas as it was: the seed is an enhancement, never a gate.
    static func load(asset: AssetRef, source: (any ImageSource)?) async -> CGImage? {
        let data = await bytes(for: asset, source: source)
        return await ThumbnailDecoder.image(for: data, key: decodeKey(for: asset))
    }

    static func bytes(for asset: AssetRef, source: (any ImageSource)?) async -> Data? {
        guard let catalog = asset.catalog else {
            return await ThumbnailProvider.local()
                .thumbnail(for: PreviewViewVM.thumbnailSource(for: asset, source: source))
        }
        return await CloudThumbCache().get(
            host: catalog.serverID.cacheHostKey, absPath: catalog.absPath)
    }

    /// The decoded-bitmap cache key. Deliberately the SAME key
    /// `AsyncThumbnail` uses, not a seed-private one: Preview and the
    /// filmstrip paint this asset immediately before the editor opens, so
    /// sharing the key turns the seed into a cache hit on an already-decoded
    /// bitmap instead of a second decode of identical bytes under a second
    /// entry.
    static func decodeKey(for asset: AssetRef) -> String {
        asset.stableID ?? asset.id.uuidString
    }
}
