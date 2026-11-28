// ThumbnailRetryTests — a visible grid or filmstrip cell retries an empty
// thumbnail a bounded number of times instead of staying grey until the
// user scrolls it away and back (#5735).

import XCTest

@testable import MapleCore

final class ThumbnailRetryTests: XCTestCase {
  private actor Attempts {
    private(set) var count = 0
    private(set) var slept: [Duration] = []
    func next() -> Int {
      count += 1
      return count
    }
    func sleep(_ delay: Duration) { slept.append(delay) }
  }

  func testEmptyResultIsRetriedUntilBytesArrive() async {
    let attempts = Attempts()
    let sleep: (Duration) async throws -> Void = { await attempts.sleep($0) }
    let result = await ThumbnailRetry.load(
      delays: [.seconds(1), .seconds(3), .seconds(9)], sleep: sleep
    ) { () async -> String? in
      await attempts.next() == 3 ? "thumbnail" : nil
    }
    XCTAssertEqual(result, "thumbnail")
    let count = await attempts.count
    let slept = await attempts.slept
    XCTAssertEqual(count, 3)
    XCTAssertEqual(slept, [.seconds(1), .seconds(3)])
  }

  func testRetriesStopAtTheBound() async {
    let attempts = Attempts()
    let sleep: (Duration) async throws -> Void = { await attempts.sleep($0) }
    let result = await ThumbnailRetry.load(delays: [.seconds(1), .seconds(3)], sleep: sleep) {
      () async -> String? in
      _ = await attempts.next()
      return nil
    }
    XCTAssertNil(result)
    let count = await attempts.count
    XCTAssertEqual(count, 3, "one load plus one retry per delay, never more")
  }

  func testFirstSuccessIsNotRetried() async {
    let attempts = Attempts()
    let sleep: (Duration) async throws -> Void = { await attempts.sleep($0) }
    let result = await ThumbnailRetry.load(sleep: sleep) { () async -> String? in
      _ = await attempts.next()
      return "thumbnail"
    }
    XCTAssertEqual(result, "thumbnail")
    let count = await attempts.count
    let slept = await attempts.slept
    XCTAssertEqual(count, 1)
    XCTAssertTrue(slept.isEmpty)
  }

  func testACellThatLeavesTheScreenStopsRetrying() async {
    let attempts = Attempts()
    let cell = Task {
      let sleep: (Duration) async throws -> Void = { delay in
        await attempts.sleep(delay)
        withUnsafeCurrentTask { $0?.cancel() }
        try Task.checkCancellation()
      }
      return await ThumbnailRetry.load(delays: [.seconds(1), .seconds(3)], sleep: sleep) {
        () async -> String? in
        _ = await attempts.next()
        return nil
      }
    }
    let result = await cell.value
    XCTAssertNil(result)
    let count = await attempts.count
    XCTAssertEqual(count, 1, "a cancelled cell makes no further attempts")
  }

  func testServerScheduleBacksOffThenKeepsAskingEveryThirtySeconds() {
    let firstSeven = Array(ThumbnailRetry.serverDelays.prefix(7))
    XCTAssertEqual(
      firstSeven,
      [
        .seconds(2), .seconds(6), .seconds(15), .seconds(30), .seconds(30), .seconds(30),
        .seconds(30),
      ])
  }

  func testOnlyServerRenderedThumbnailsGetTheOpenEndedSchedule() {
    let cloudAsset = AssetRef(
      displayName: "a.cr2", hintExtension: "cr2", stableID: "fs:/a.cr2",
      bytesProvider: { throw CancellationError() })
    let localAsset = AssetRef(url: URL(fileURLWithPath: "/tmp/a.cr2"))
    let onDevice = ThumbnailRetry.onDeviceDelays
    XCTAssertEqual(Array(ThumbnailRetry.schedule(for: localAsset, from: nil)), onDevice)
    XCTAssertEqual(Array(ThumbnailRetry.schedule(for: cloudAsset, from: nil)), onDevice)
    XCTAssertEqual(
      Array(ThumbnailRetry.schedule(for: cloudAsset, from: ServerSource()).prefix(5)),
      Array(ThumbnailRetry.serverDelays.prefix(5)))
    XCTAssertEqual(Array(ThumbnailRetry.schedule(for: .photoKit(localID: "x"))), onDevice)
  }

  private actor ServerSource: ImageSource {
    nonisolated var thumbnailsAreLatencyBound: Bool { true }
    func images() async throws -> [ImageRef] { [] }
    func thumb(for ref: ImageRef) async throws -> Data? { nil }
    func preview(for ref: ImageRef) async throws -> Data? { nil }
    func rawBytes(for ref: ImageRef) async throws -> Data { throw CancellationError() }
    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
    func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
  }
}
