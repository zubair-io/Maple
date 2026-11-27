import Foundation

extension BrowseViewModel {
  public func invalidateGridFilterForAssetIdentityChange() {
    gridFilterAssetIdentityGeneration &+= 1
    gridFilterFacts = .empty
    gridFilterLoadGeneration &+= 1
    if gridFilter != .all { gridFilterLoading = true }
  }

  public func selectGridFilter(_ filter: GridFilter) {
    guard gridFilter != filter else { return }
    gridFilter = filter
    selectedIDs = []
    selectedID = nil
    UserDefaults.standard.set(filter.rawValue, forKey: "cm.filter")
    gridFilterLoadGeneration &+= 1
    gridFilterMetadata = [:]
    gridFilterError = nil
    gridFilterLoading = filter != .all
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
    let kept = gridFilterFacts
    gridFilterLoading = true
    gridFilterError = nil
    gridFilterMetadata = [:]

    let load: @Sendable (AssetRef) async throws -> GridFilterFactCache.Loaded = { asset in
      let stamp = GridFilterSidecarStamp.current(for: asset)
      let metadata =
        if let reused = kept.reusableMetadata(for: asset.id, stamp: stamp) {
          reused
        } else {
          try await read(asset)
        }
      return .init(id: asset.id, stamp: stamp, metadata: metadata)
    }

    do {
      var loaded: [GridFilterFactCache.Loaded] = []
      loaded.reserveCapacity(listedAssets.count)
      try await withThrowingTaskGroup(of: GridFilterFactCache.Loaded.self) { group in
        var next = listedAssets.makeIterator()
        for _ in 0..<min(8, listedAssets.count) {
          if let asset = next.next() {
            group.addTask { try await load(asset) }
          }
        }
        while let item = try await group.next() {
          try Task.checkCancellation()
          loaded.append(item)
          if let asset = next.next() {
            group.addTask { try await load(asset) }
          }
        }
      }
      guard generation == gridFilterLoadGeneration, listing == listingGeneration,
        !Task.isCancelled
      else { return }
      gridFilterFacts = GridFilterFactCache(loaded: loaded)
      gridFilterMetadata = loaded.reduce(into: [:]) { $0[$1.id] = $1.metadata }
      gridFilterLoading = false
      selectedIDs.formIntersection(Set(gridAssets(sessions: [:]).map(\.id)))
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
