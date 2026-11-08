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
}
