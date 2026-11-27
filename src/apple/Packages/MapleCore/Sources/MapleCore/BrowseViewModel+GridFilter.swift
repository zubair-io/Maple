import Foundation

extension BrowseViewModel {
  public func invalidateGridFilterForAssetIdentityChange() {
    gridFilterAssetIdentityGeneration &+= 1
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
    let identity = gridFilterAssetIdentityGeneration
    let listedAssets = assets
    gridFilterLoading = true
    gridFilterError = nil
    gridFilterMetadata = [:]

    let stamps = await GridFilterSidecarStamp.stamps(for: listedAssets)
    guard generation == gridFilterLoadGeneration, listing == listingGeneration,
      !Task.isCancelled
    else { return }
    let reused = gridFilterFacts.reusable(listing: listing, identity: identity, stamps: stamps)
    let unread = listedAssets.filter { reused[$0.id] == nil }

    do {
      var result = reused
      try await withThrowingTaskGroup(of: (AssetRef.ID, GridFilterMetadata).self) { group in
        var next = unread.makeIterator()
        for _ in 0..<min(8, unread.count) {
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
      gridFilterFacts = GridFilterFactCache(
        listingGeneration: listing,
        assetIdentityGeneration: identity,
        entries: listedAssets.reduce(into: [:]) { entries, asset in
          guard let stamp = stamps[asset.id], let metadata = result[asset.id] else { return }
          entries[asset.id] = .init(stamp: stamp, metadata: metadata)
        })
      gridFilterMetadata = result
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
