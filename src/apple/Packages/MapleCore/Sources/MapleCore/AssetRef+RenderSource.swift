import Foundation

extension AssetRef {
  /// Preserve browse identity and source routing while sharing the editor's
  /// existing temporary RAW copy. Browse refs themselves remain lightweight.
  init(sharingBytesOf asset: AssetRef, through source: RawRenderSource) {
    id = asset.id
    primaryURL = asset.primaryURL
    displayNameOverride = asset.displayNameOverride
    hintExtension = asset.hintExtension
    bytesProvider = asset.bytesProvider.map { _ in
      { try await source.bytes(for: asset) }
    }
    displayPreviewProvider = asset.displayPreviewProvider
    stableID = asset.stableID
    scopeParentURL = asset.scopeParentURL
    explicitIsRaw = asset.explicitIsRaw
    thumbnailProvenance = asset.thumbnailProvenance
    catalog = asset.catalog
  }
}
