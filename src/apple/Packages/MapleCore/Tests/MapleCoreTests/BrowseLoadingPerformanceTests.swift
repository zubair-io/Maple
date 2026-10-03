import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class BrowseLoadingPerformanceTests: XCTestCase {
  /// An independent observer checks the real loader's queued producers rather
  /// than assuming that cancelling SwiftUI's caller cancels its detached task.
  func testOffscreenLoadCancelsBeforeReadingRawBytes() async throws {
    let loader = ThumbnailLoader()
    for _ in 0..<ThumbnailLoader.maxConcurrentDecodes {
      try await loader.acquireDecodeSlot()
    }
    let asset = AssetRef(
      displayName: "cancelled.dng", hintExtension: "dng",
      stableID: UUID().uuidString,
      bytesProvider: {
        XCTFail("An offscreen queued cell must not read its RAW")
        throw CancellationError()
      })
    let load = Task { await loader.load(for: asset, from: nil) }
    await waitForQueue(loader)
    load.cancel()
    let result = await load.value
    XCTAssertNil(result)
    let queued = await loader.decodeSlots.queuedCount
    XCTAssertEqual(queued, 0)
    for _ in 0..<ThumbnailLoader.maxConcurrentDecodes {
      await loader.releaseDecodeSlot()
    }
  }

  func testCancellingOneCellDoesNotCancelAnotherVisibleConsumer() async throws {
    let loader = ThumbnailLoader()
    let gate = BoundedAsyncSemaphore(value: 1)
    try await gate.acquire()
    let producer = Task { () -> Data? in
      do { try await gate.acquire() } catch { return nil }
      await gate.release()
      return Data([42])
    }
    let first = Task { await loader.awaitThumbnail(producer) }
    let second = Task { await loader.awaitThumbnail(producer) }
    for _ in 0..<10_000 {
      if await loader.thumbnailWaiters[producer]?.count == 2 { break }
      await Task.yield()
    }
    let sharedCount = await loader.thumbnailWaiters[producer]?.count
    XCTAssertEqual(sharedCount, 2)
    first.cancel()
    for _ in 0..<10_000 {
      if await loader.thumbnailWaiters[producer]?.count == 1 { break }
      await Task.yield()
    }
    let visibleCount = await loader.thumbnailWaiters[producer]?.count
    XCTAssertEqual(visibleCount, 1)
    XCTAssertFalse(producer.isCancelled)
    await gate.release()
    let visibleResult = await second.value
    XCTAssertEqual(visibleResult, Data([42]))
    _ = await first.value
  }

  func testFolderSwitchPreservesPermitsHeldByRunningDecodes() async throws {
    let loader = ThumbnailLoader()
    for _ in 0..<ThumbnailLoader.maxConcurrentDecodes {
      try await loader.acquireDecodeSlot()
    }
    await loader.cancelAll()
    // Previous-folder work still holds every permit until it finishes. A
    // reset-to-zero would admit this new-folder task above the hardware cap.
    let next = Task { try await loader.acquireDecodeSlot() }
    await waitForQueue(loader)
    await loader.releaseDecodeSlot()
    try await next.value
    await loader.releaseDecodeSlot()
    for _ in 1..<ThumbnailLoader.maxConcurrentDecodes {
      await loader.releaseDecodeSlot()
    }
  }

  @MainActor
  func test250BrowseSessionsDoNotCreateRenderContexts() {
    let start = ContinuousClock.now
    let sessions = (0..<250).map { index in
      EditSession(asset: AssetRef.preview(displayName: "image-\(index).dng"))
    }
    XCTAssertTrue(sessions.allSatisfy { !$0.pipeline.contextStorage.isInitialized })
    print("Browse: 250 session creations without Metal contexts: \(start.duration(to: .now))")
  }

  @MainActor
  func testFolderListingPublishes250ImagesWithoutOpeningThem() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    for index in 0..<250 {
      try Data().write(to: folder.appendingPathComponent(String(format: "%04d.dng", index)))
    }
    try FileManager.default.createDirectory(
      at: folder.appendingPathComponent("child"), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(
      at: folder.appendingPathComponent(".maple"), withIntermediateDirectories: true)
    let browser = BrowseViewModel()
    await browser.loadFolder(url: folder)
    XCTAssertEqual(browser.assets.count, 250)
    XCTAssertEqual(browser.subfolders.map(\.lastPathComponent), ["child"])
    XCTAssertNil(browser.selectedID)
    XCTAssertNil(browser.loadError)
    XCTAssertFalse(browser.isLoading)
    XCTAssertTrue(browser.assets.allSatisfy { $0.scopeParentURL == folder })
  }

  @MainActor
  func testSupersededFolderListingCannotReplaceNewSource() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let browser = BrowseViewModel()
    let listing = Task { await browser.loadFolder(url: folder) }
    // The detached directory walk necessarily suspends its MainActor caller.
    // Invalidate it at that boundary, before its result can be published.
    for _ in 0..<10_000 {
      if browser.isLoading { break }
      await Task.yield()
    }
    XCTAssertTrue(browser.isLoading)
    browser.setPhotosAuthNeeded(canRequest: false)
    await listing.value
    XCTAssertTrue(browser.photosAuthNeeded)
    XCTAssertFalse(browser.photosAuthCanRequest)
    XCTAssertTrue(browser.assets.isEmpty)
  }

  @MainActor
  func testCancelledBrowseHydrationRetriesPersistedEditsOnOpen() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let raw = folder.appendingPathComponent("image.dng")
    let model = AdjustmentModel(exposure: 1.25)
    let culling = CullingState(stars: 4, flag: .pick)
    let xml = XMPSerializer.serialize(model: model, culling: culling)
    try Data(xml.utf8).write(to: SidecarPath.sidecarURL(for: raw))
    let session = EditSession(asset: AssetRef(url: raw))
    let hydration = Task { await session.loadSidecar() }
    hydration.cancel()
    await hydration.value
    XCTAssertFalse(session.hasLoadedSidecar)
    await session.loadSidecar()
    XCTAssertTrue(session.hasLoadedSidecar)
    XCTAssertEqual(session.model.exposure, 1.25)
    XCTAssertEqual(session.culling.stars, 4)
    XCTAssertEqual(session.culling.flag, .pick)
    XCTAssertFalse(session.pipeline.contextStorage.isInitialized)
  }

  func testConcurrentRenderPathsShareOneLazyContext() async {
    let storage = PipelineContext()
    XCTAssertFalse(storage.isInitialized)
    let contexts = await withTaskGroup(of: CIContext.self, returning: [CIContext].self) { group in
      for _ in 0..<16 { group.addTask { storage.value } }
      var contexts: [CIContext] = []
      for await context in group { contexts.append(context) }
      return contexts
    }
    XCTAssertTrue(storage.isInitialized)
    XCTAssertEqual(contexts.count, 16)
    XCTAssertTrue(contexts.allSatisfy { $0 === contexts[0] })
  }

  private func waitForQueue(_ loader: ThumbnailLoader) async {
    for _ in 0..<10_000 {
      if await loader.decodeSlots.queuedCount > 0 { return }
      await Task.yield()
    }
    XCTFail("Producer never reached the thumbnail queue")
  }
}
