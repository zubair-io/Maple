import Foundation

extension BrowseViewModel {
  /// Only called from the PhotoKit paging loaders (`loadPhotoKitSource`,
  /// `loadMorePhotoKitIfNeeded`) — every ref built here IS PhotoKit-backed,
  /// so `thumbnailProvenance` is tagged unconditionally (#2299).
  func makeAssetRef(_ ref: ImageRef, source: any ImageSource) -> AssetRef {
    if let url = ref.url {
      return AssetRef(url: url, scopeParentURL: ref.scopeParentURL, captureDate: ref.captureDate)
    }
    let ext = (ref.displayName as NSString).pathExtension.lowercased()
    return AssetRef(
      displayName: ref.displayName,
      hintExtension: ext.isEmpty ? nil : ext,
      stableID: ref.id,
      captureDate: ref.captureDate,
      thumbnailProvenance: .photoKit,
      bytesProvider: { [source, ref] in try await source.rawBytes(for: ref) }
    )
  }

}
