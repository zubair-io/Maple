// ThumbnailLoaderSourcelessProducerTests — a Maple Cloud thumbnail fetch
// that has started finishes and fills the cache even when every cell that
// asked for it has scrolled away (#5735). Before, the last waiter leaving
// cancelled the request mid-flight, so the cache stayed empty and the cell
// stayed grey until it was re-created.

import XCTest

@testable import MapleCore

final class ThumbnailLoaderSourcelessProducerTests: XCTestCase {
  private actor BlockingSource: ImageSource {
    let work = BlockingWork()

    func images() async throws -> [ImageRef] { [] }
    func thumb(for ref: ImageRef) async throws -> Data? {
      guard let bytes = await work.run() else { throw CancellationError() }
      return bytes
    }
    func preview(for ref: ImageRef) async throws -> Data? { nil }
    func rawBytes(for ref: ImageRef) async throws -> Data { throw CancellationError() }
    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
    func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
  }

  private func makeAsset() -> (AssetRef, String) {
    let stableID = "fs:/library/producer-\(UUID().uuidString).dng"
    let asset = AssetRef(
      displayName: "producer.dng", hintExtension: "dng", stableID: stableID,
      bytesProvider: { throw URLError(.notConnectedToInternet) })
    return (asset, stableID)
  }

  func testLastWaiterLeavingMidFetchStillFillsTheCache() async {
    let (asset, stableID) = makeAsset()
    defer { removeSourcelessThumbCacheFile(forKey: stableID) }
    let source = BlockingSource()
    let loader = ThumbnailLoader()

    let cell = Task { await loader.load(for: asset, from: source) }
    await source.work.waitUntilStarted()
    cell.cancel()
    await waitForWaiters(loader, key: "sourceless:" + stableID, count: 0)
    await source.work.release()

    let delivered = await cell.value
    XCTAssertNil(delivered, "the cancelled cell gets nothing back")
    await source.work.waitUntilFinished()
    let sawCancellation = await source.work.sawCancellation
    XCTAssertFalse(sawCancellation, "the request already on the wire runs to completion")
    let cached = await waitForCache(key: stableID)
    XCTAssertEqual(cached, BlockingWork.bytes)
  }

  func testOneCellLeavingStillDeliversToTheCellThatStays() async {
    let (asset, stableID) = makeAsset()
    defer { removeSourcelessThumbCacheFile(forKey: stableID) }
    let source = BlockingSource()
    let loader = ThumbnailLoader()
    let key = "sourceless:" + stableID

    let leaving = Task { await loader.load(for: asset, from: source) }
    await source.work.waitUntilStarted()
    let staying = Task { await loader.load(for: asset, from: source) }
    await waitForWaiters(loader, key: key, count: 2)
    leaving.cancel()
    await waitForWaiters(loader, key: key, count: 1)
    await source.work.release()

    let delivered = await staying.value
    XCTAssertEqual(delivered, BlockingWork.bytes)
    let runs = await source.work.runs
    XCTAssertEqual(runs, 1, "both cells share one request")
  }

  private func waitForWaiters(
    _ loader: ThumbnailLoader, key: String, count: Int,
    file: StaticString = #filePath, line: UInt = #line
  ) async {
    let deadline = ContinuousClock.now + .seconds(5)
    while ContinuousClock.now < deadline {
      if await loader.waiterCount(forKey: key) == count { return }
      try? await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("waiter count never reached \(count)", file: file, line: line)
  }

  private func waitForCache(key: String) async -> Data? {
    let deadline = ContinuousClock.now + .seconds(5)
    while ContinuousClock.now < deadline {
      if let data = await ThumbnailDiskCache.shared.thumbnailData(forKey: key) { return data }
      try? await Task.sleep(for: .milliseconds(5))
    }
    return nil
  }
}
