import Foundation

extension BrowseViewModel {
  /// Publish two phone screens immediately, then retain PhotoKit's lazy
  /// fetch result as the backing store for scroll-driven paging.
  public func loadPhotoKitSource(_ source: PhotoKitSource) async {
    retryLoader = { [weak self] in
      guard let self else { return }
      await self.loadPhotoKitSource(source)
    }
    loadGeneration &+= 1
    let gen = loadGeneration
    isLoading = true
    pagedPhotoKitSource = source
    photoKitNextOffset = 0
    photoKitTotalCount = 0
    finishPhotoKitPageLoad()
    defer { if gen == loadGeneration { isLoading = false } }

    do {
      async let total = source.imageCount()
      async let firstPage = source.images(offset: 0, limit: Self.photoKitPageSize)
      let (count, refs) = try await (total, firstPage)
      guard gen == loadGeneration else { return }
      assets = refs.map { makeAssetRef($0, source: source) }
      photoKitNextOffset = refs.count
      photoKitTotalCount = count
      subfolders = []
      selectedID = nil
      currentSource = source
      loadError = nil
      photosAuthNeeded = false
      listingGeneration &+= 1
    } catch {
      guard gen == loadGeneration else { return }
      loadError = error
    }
  }

  public func loadMorePhotoKitIfNeeded(appearing id: AssetRef.ID) async {
    guard currentSource is PhotoKitSource,
      let source = pagedPhotoKitSource,
      !isLoadingPhotoKitPage,
      photoKitNextOffset < photoKitTotalCount,
      let index = assets.firstIndex(where: { $0.id == id }),
      index >= max(0, assets.count - Self.photoKitPrefetchDistance)
    else { return }

    isLoadingPhotoKitPage = true
    let gen = loadGeneration
    let offset = photoKitNextOffset
    defer { if gen == loadGeneration { finishPhotoKitPageLoad() } }
    do {
      let refs = try await source.images(offset: offset, limit: Self.photoKitPageSize)
      guard gen == loadGeneration else { return }
      assets.append(contentsOf: refs.map { makeAssetRef($0, source: source) })
      photoKitNextOffset += refs.count
    } catch {
      guard gen == loadGeneration else { return }
      loadError = error
    }
  }

  /// A metadata filter must cover the whole Photos listing even when none
  /// of the first page's tiles match and therefore no paging tile appears.
  public func loadRemainingPhotoKitForFilter() async throws {
    guard gridFilter != .all, currentSource is PhotoKitSource else { return }
    try await waitForActivePhotoKitPage()
    guard let source = pagedPhotoKitSource,
      photoKitNextOffset < photoKitTotalCount
    else { return }
    isLoadingPhotoKitPage = true
    let gen = loadGeneration
    var offset = photoKitNextOffset
    var remaining: [AssetRef] = []
    defer { if gen == loadGeneration { finishPhotoKitPageLoad() } }
    while offset < photoKitTotalCount {
      try Task.checkCancellation()
      let refs = try await source.images(offset: offset, limit: Self.photoKitFilterDrainPageSize)
      guard gen == loadGeneration else { throw CancellationError() }
      guard !refs.isEmpty else {
        throw ImageSourceError.notFound("The Photos listing ended before all photos were loaded")
      }
      remaining.append(contentsOf: refs.map { makeAssetRef($0, source: source) })
      offset += refs.count
    }
    try Task.checkCancellation()
    guard gen == loadGeneration else { throw CancellationError() }
    assets.append(contentsOf: remaining)
    photoKitNextOffset = offset
  }

  /// A previous filter's cancelled drain still owns the page slot until its
  /// deferred cleanup runs. Suspend without polling until it releases the slot.
  func waitForActivePhotoKitPage() async throws {
    while isLoadingPhotoKitPage {
      try Task.checkCancellation()
      let token = UUID()
      let released = AsyncStream<Void> { continuation in
        photoKitPageWaiters[token] = continuation
      }
      for await _ in released {}
      photoKitPageWaiters.removeValue(forKey: token)
    }
    try Task.checkCancellation()
  }

  func finishPhotoKitPageLoad() {
    isLoadingPhotoKitPage = false
    let waiters = Array(photoKitPageWaiters.values)
    photoKitPageWaiters.removeAll()
    for waiter in waiters { waiter.finish() }
  }
}
