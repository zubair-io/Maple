// EditorSeed+VM.swift — where the editor's seed thumbnail comes
// from (#2374). No SwiftUI: this is the unit-testable half of
// `EditorSeedLoader`, per the view-model split in pattern #192.

import CoreGraphics
import Foundation
import MapleCore

enum EditorSeedVM {
  /// The asset's existing thumbnail bytes, decoded.
  ///
  /// Catalog-backed (Maple Cloud) refs resolve through
  /// `EditorCanvasSeed.cloudThumbnailBytes`, which reads whichever cache the
  /// grid that listed them populated (#5731). Everything else goes through
  /// the same `ThumbnailProvider` route the grid, filmstrip and Preview use.
  /// A miss simply leaves the canvas as it was: the seed is an enhancement,
  /// never a gate.
  static func load(asset: AssetRef, source: (any ImageSource)?) async -> CGImage? {
    let key = await decodeKey(for: asset)
    let data = await bytes(for: asset, source: source)
    return await ThumbnailDecoder.image(for: data, key: key)
  }

  static func bytes(for asset: AssetRef, source: (any ImageSource)?) async -> Data? {
    guard let catalog = asset.catalog else {
      return await ThumbnailProvider.local()
        .thumbnail(for: PreviewViewVM.thumbnailSource(for: asset, source: source))
    }
    return await EditorCanvasSeed.cloudThumbnailBytes(
      asset: asset, catalog: catalog, server: EditorCanvasSeed.server(source, serving: catalog))
  }

  /// The display-resolution still Preview shows (the server's 1280 px
  /// preview for a Cloud asset), for assets with no local file: those sit
  /// behind a download with no other seed, while local files already get
  /// cached and embedded previews from the session. Decoded unmemoized,
  /// like Preview's own display tier.
  static func loadDisplayPreview(asset: AssetRef, source: (any ImageSource)?) async -> CGImage? {
    guard asset.primaryURL == nil else { return nil }
    let owningSource: (any ImageSource)? = {
      guard let catalog = asset.catalog else { return source }
      return EditorCanvasSeed.server(source, serving: catalog)
    }()
    let route = PreviewViewVM.thumbnailSource(for: asset, source: owningSource)
    guard case .local = route else { return nil }
    guard let data = await ThumbnailProvider.local().preview(for: route) else { return nil }
    return await ThumbnailDecoder.decodeFull(data)
  }

  /// The decoded-bitmap cache key. Deliberately the SAME key
  /// `AsyncThumbnail` uses, not a seed-private one: Preview and the
  /// filmstrip paint this asset immediately before the editor opens, so
  /// sharing the key turns the seed into a cache hit on an already-decoded
  /// bitmap instead of a second decode of identical bytes under a second
  /// entry.
  @MainActor static func decodeKey(for asset: AssetRef) async -> String {
    await DevelopedImageRevision.shared.decodedKeyAsync(
      for: asset.stableID ?? asset.id.uuidString, source: .local(asset, source: nil))
  }
}
