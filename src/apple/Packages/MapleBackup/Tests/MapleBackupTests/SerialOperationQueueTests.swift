// Tests/MapleBackupTests/SerialOperationQueueTests.swift
// EngineHost runs every start and stop through one SerialOperationQueue
// (#5022), so a second Stop or a Start can never interleave with a teardown
// that is still draining.
import XCTest

@testable import MapleBackup

@MainActor
final class SerialOperationQueueTests: XCTestCase {
  func testOperationsNeverOverlapAndRunInCallOrder() async {
    let queue = SerialOperationQueue()
    var log: [String] = []
    let first = Task {
      await queue.run {
        log.append("first begins")
        try? await Task.sleep(for: .milliseconds(150))
        log.append("first ends")
      }
    }
    await Task.yield()
    let second = Task { await queue.run { log.append("second") } }
    await first.value
    await second.value
    XCTAssertEqual(log, ["first begins", "first ends", "second"])
  }

  func testAnOperationFinishesEvenWhenItsCallerIsCancelled() async {
    let queue = SerialOperationQueue()
    var finished = false
    let began = expectation(description: "operation began")
    let caller = Task {
      await queue.run {
        began.fulfill()
        try? await Task.sleep(for: .milliseconds(100))
        finished = true
      }
    }
    await fulfillment(of: [began], timeout: 2)
    caller.cancel()
    await queue.run {}
    XCTAssertTrue(finished)
  }
}
