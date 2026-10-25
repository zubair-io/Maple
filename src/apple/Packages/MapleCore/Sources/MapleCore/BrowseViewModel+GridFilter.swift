import Foundation

extension BrowseViewModel {
  public func selectGridFilter(_ filter: GridFilter) {
    gridFilter = filter
    UserDefaults.standard.set(filter.rawValue, forKey: "cm.filter")
    gridFilterLoadGeneration &+= 1
    gridFilterMetadata = [:]
    gridFilterError = nil
  }

  /// Load metadata for the whole listing before showing filtered results.
  /// Visible-cell session hydration alone misses every offscreen match.
  public func loadGridFilterMetadata(
    read: @escaping @MainActor @Sendable (AssetRef) async throws -> GridFilterMetadata
  ) async {
    guard gridFilter != .all else {
      gridFilterLoading = false
      return
    }
    gridFilterLoadGeneration &+= 1
    let generation = gridFilterLoadGeneration
    let listing = listingGeneration
    let listedAssets = assets
    gridFilterLoading = true
    gridFilterError = nil
    gridFilterMetadata = [:]

    do {
      var result: [AssetRef.ID: GridFilterMetadata] = [:]
      try await withThrowingTaskGroup(of: (AssetRef.ID, GridFilterMetadata).self) { group in
        var next = listedAssets.makeIterator()
        for _ in 0..<min(8, listedAssets.count) {
          if let asset = next.next() {
            group.addTask { (asset.id, try await read(asset)) }
          }
        }
        while let (id, metadata) = try await group.next() {
          try Task.checkCancellation()
          result[id] = metadata
          if let asset = next.next() {
            group.addTask { (asset.id, try await read(asset)) }
          }
        }
      }
      guard generation == gridFilterLoadGeneration, listing == listingGeneration,
        !Task.isCancelled
      else { return }
      gridFilterMetadata = result
      gridFilterLoading = false
    } catch {
      guard generation == gridFilterLoadGeneration, listing == listingGeneration,
        !Task.isCancelled
      else { return }
      gridFilterError = error
      gridFilterLoading = false
    }
  }

  public func gridAssets(sessions: [AssetRef.ID: EditSession]) -> [AssetRef] {
    guard gridFilter != .all else { return assets }
    guard !gridFilterLoading, gridFilterError == nil,
      gridFilterMetadata.count == assets.count
    else { return [] }
    return assets.filter { asset in
      guard let metadata = gridFilterMetadata[asset.id] else { return false }
      let session = sessions[asset.id]
      let culling =
        session.flatMap { $0.hasLoadedSidecar ? $0.culling : nil }
        ?? metadata.culling
      switch gridFilter {
      case .all: return true
      case .picks: return culling.flag == .pick
      case .fourStars: return culling.stars >= 4
      case .edited:
        return metadata.hasEdits || (session != nil && asset.hasEdits)
      }
    }
  }
}
