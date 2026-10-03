import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class BrowseCancellationOwnershipTests: XCTestCase {
  func testOneCancelledConsumerDoesNotCancelAnotherRealThumbnailConsumer() async throws {
    let fixture = try XCTUnwrap(Self.fixture("test-fixtures/batch-transfer/source.dng"))
    let bytes = try Data(contentsOf: fixture)
    let fence = BrowseFilesystemFence()
    let loader = ThumbnailLoader()
    let key = UUID().uuidString
    let asset = AssetRef(
      displayName: "shared.dng", hintExtension: "dng", stableID: key,
      bytesProvider: {
        await fence.enter()
        return bytes
      })
    let first = Task { await loader.load(for: asset, from: nil) }
    await fulfillment(of: [fence.entered], timeout: 5)
    let second = Task { await loader.load(for: asset, from: nil) }
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while ContinuousClock.now < deadline {
      if await loader.thumbnailWaiters.values.reduce(0) { $0 + $1.count } == 2 { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    let waiterCount = await loader.thumbnailWaiters.values.reduce(0) { $0 + $1.count }
    XCTAssertEqual(waiterCount, 2)
    first.cancel()
    // The native render runs after the actual provider's fence. The remaining
    // consumer must still receive decoded pixels, rather than a cancelled job.
    await fence.release()
    let firstResult = await first.value
    let secondResult = await second.value
    XCTAssertNil(firstResult)
    let result = try XCTUnwrap(secondResult, "Cancelling one cell cancelled the shared producer")
    XCTAssertNotNil(CIImage(data: result))
    XCTAssertEqual(try Data(contentsOf: fixture), bytes)
  }

  func testCompletedSharedConsumersLeaveNoStaleThumbnailOwnership() async throws {
    let fixture = try XCTUnwrap(Self.fixture("test-fixtures/batch-transfer/source.dng"))
    let bytes = try Data(contentsOf: fixture)
    let fence = BrowseFilesystemFence()
    let loader = ThumbnailLoader()
    let key = UUID().uuidString
    let asset = AssetRef(
      displayName: "shared-completion.dng", hintExtension: "dng", stableID: key,
      bytesProvider: {
        await fence.enter()
        return bytes
      })
    let first = Task(priority: .userInitiated) { await loader.load(for: asset, from: nil) }
    await fulfillment(of: [fence.entered], timeout: 5)
    let second = Task(priority: .background) { await loader.load(for: asset, from: nil) }
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while ContinuousClock.now < deadline {
      if await loader.thumbnailWaiters.values.reduce(0) { $0 + $1.count } == 2 { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    let count = await loader.thumbnailWaiters.values.reduce(0) { $0 + $1.count }
    XCTAssertEqual(count, 2)
    await fence.release()
    let firstPixels = await first.value
    let secondPixels = await second.value
    XCTAssertNotNil(CIImage(data: try XCTUnwrap(firstPixels)))
    XCTAssertEqual(firstPixels, secondPixels)
    let remaining = await loader.thumbnailWaiters
    let producer = await loader.inFlight["sourceless:" + key]
    XCTAssertTrue(remaining.isEmpty, "Completed consumer ownership leaked into the next request")
    XCTAssertNil(producer)
    XCTAssertEqual(try Data(contentsOf: fixture), bytes)
  }

  @MainActor
  func testCancelledActualFolderEnumerationDoesNotPublishAbandonedFiles() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let original = Data("owned enumeration fixture".utf8)
    let photo = folder.appendingPathComponent("photo.dng")
    try original.write(to: photo)
    let fence = BrowseFilesystemFence()
    let browser = BrowseViewModel()
    browser.folderEnumerationCheckpoint = { await fence.enter() }
    let load = Task { await browser.loadFolder(url: folder) }
    await fulfillment(of: [fence.entered], timeout: 5)
    load.cancel()
    await fence.release()
    await load.value
    XCTAssertTrue(browser.assets.isEmpty, "A cancelled directory walk published its old files")
    XCTAssertNil(browser.loadError, "Cancellation must not become an unreadable-folder banner")
    XCTAssertFalse(browser.isLoading)
    XCTAssertEqual(try Data(contentsOf: photo), original)
  }

  @MainActor
  func testRapidFolderSwitchKeepsRunningWalkBoundedAndDropsQueuedOldFolder() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let bytes = Data("owned bounded enumeration".utf8)
    let folders = try ["first", "abandoned", "latest"].map { name in
      let folder = root.appendingPathComponent(name)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try bytes.write(to: folder.appendingPathComponent(name + ".dng"))
      return folder
    }
    let browser = BrowseViewModel()
    let firstFence = BrowseFilesystemFence()
    browser.folderEnumerationCheckpoint = { await firstFence.enter() }
    let first = Task { await browser.loadFolder(url: folders[0]) }
    await fulfillment(of: [firstFence.entered], timeout: 5)
    browser.folderEnumerationCheckpoint = {
      XCTFail("Superseded queued folder performed metadata I/O")
    }
    let abandoned = Task { await browser.loadFolder(url: folders[1]) }
    await waitForFolderQueue(browser)
    let latestFence = BrowseFilesystemFence()
    browser.folderEnumerationCheckpoint = { await latestFence.enter() }
    let latest = Task { await browser.loadFolder(url: folders[2]) }
    for _ in 0..<10_000 {
      if browser.loadGeneration == 3 { break }
      await Task.yield()
    }
    XCTAssertEqual(browser.loadGeneration, 3)
    await waitForFolderQueue(browser)
    // The first real walk remains held in its post-listing fence. Neither
    // replacement may pass the single permit until that actual work returns.
    XCTAssertTrue(browser.assets.isEmpty)
    await firstFence.release()
    await fulfillment(of: [latestFence.entered], timeout: 5)
    await latestFence.release()
    await first.value
    await abandoned.value
    await latest.value
    XCTAssertEqual(browser.assets.map(\.displayName), ["latest"])
    XCTAssertNil(browser.loadError)
    XCTAssertFalse(browser.isLoading)
    let queued = await browser.folderEnumerationSlots.queuedCount
    XCTAssertEqual(queued, 0)
    for (index, folder) in folders.enumerated() {
      let name = ["first", "abandoned", "latest"][index]
      XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent(name + ".dng")), bytes)
    }
  }

  @MainActor
  private func waitForFolderQueue(_ browser: BrowseViewModel) async {
    for _ in 0..<10_000 {
      if await browser.folderEnumerationSlots.queuedCount > 0 { return }
      await Task.yield()
    }
    XCTFail("Replacement never reached the bounded actual directory walk")
  }

  private static func fixture(_ relative: String) -> URL? {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<12 {
      root.deleteLastPathComponent()
      let candidate = root.appendingPathComponent(relative)
      if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
    }
    return nil
  }
}

private actor BrowseFilesystemFence {
  nonisolated let entered = XCTestExpectation(description: "Actual I/O reached publication fence")
  private var continuation: CheckedContinuation<Void, Never>?

  func enter() async {
    await withCheckedContinuation { continuation in
      self.continuation = continuation
      entered.fulfill()
    }
  }

  func release() {
    continuation?.resume()
    continuation = nil
  }
}
