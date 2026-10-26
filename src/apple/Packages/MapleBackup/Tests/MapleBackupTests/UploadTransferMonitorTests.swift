// Tests/MapleBackupTests/UploadTransferMonitorTests.swift
//
// The backup screen saver's "still sending" signal (#5457): a request body
// that keeps moving reads as recent, one that stops ages, and a finished
// request drops out entirely.

import XCTest
import os

@testable import MapleBackup

final class UploadTransferMonitorTests: XCTestCase {
  private let start = Date(timeIntervalSinceReferenceDate: 1_000)
  private let clock = OSAllocatedUnfairLock<TimeInterval>(initialState: 0)
  private let session = URLSession(configuration: .ephemeral)

  private func makeMonitor() -> UploadTransferMonitor {
    UploadTransferMonitor { [start, clock] in start.addingTimeInterval(clock.withLock { $0 }) }
  }

  private func advance(to seconds: TimeInterval) {
    clock.withLock { $0 = seconds }
  }

  private func uploadTask(body: Data? = Data(count: 4 * 1024 * 1024)) -> URLSessionTask {
    var request = URLRequest(url: URL(string: "https://maple.invalid/api/backup/ingest")!)
    request.httpMethod = "POST"
    request.httpBody = body
    return session.dataTask(with: request)
  }

  private func reportSent(_ monitor: UploadTransferMonitor, _ task: URLSessionTask, bytes: Int64) {
    monitor.urlSession(
      session, task: task, didSendBodyData: bytes, totalBytesSent: bytes,
      totalBytesExpectedToSend: 4 * 1024 * 1024)
  }

  func test_noRequest_reportsNothingInFlight() {
    XCTAssertNil(makeMonitor().secondsSinceBytesSent(at: start))
  }

  func test_newRequest_countsFromItsCreation() {
    let monitor = makeMonitor()
    monitor.urlSession(session, didCreateTask: uploadTask())
    XCTAssertEqual(monitor.secondsSinceBytesSent(at: start.addingTimeInterval(20)), 20)
  }

  func test_slowChunk_advancingBytesKeepTheSignalRecent() {
    let monitor = makeMonitor()
    let task = uploadTask()
    monitor.urlSession(session, didCreateTask: task)
    for (second, sent) in [(32.0, Int64(2 << 20)), (48, 3 << 20), (64, 4 << 20)] {
      advance(to: second)
      reportSent(monitor, task, bytes: sent)
      XCTAssertEqual(monitor.secondsSinceBytesSent(at: start.addingTimeInterval(second + 5)), 5)
    }
  }

  func test_bytesThatStopMoving_ageUntilStalled() {
    let monitor = makeMonitor()
    let task = uploadTask()
    monitor.urlSession(session, didCreateTask: task)
    advance(to: 10)
    reportSent(monitor, task, bytes: 1 << 20)
    advance(to: 100)
    reportSent(monitor, task, bytes: 0)
    XCTAssertEqual(monitor.secondsSinceBytesSent(at: start.addingTimeInterval(100)), 90)
  }

  func test_finishedRequest_dropsOut() {
    let monitor = makeMonitor()
    let task = uploadTask()
    monitor.urlSession(session, didCreateTask: task)
    task.cancel()
    XCTAssertNil(monitor.secondsSinceBytesSent(at: start))
  }

  func test_requestWithoutBody_isNotTracked() {
    let monitor = makeMonitor()
    monitor.urlSession(session, didCreateTask: uploadTask(body: nil))
    XCTAssertNil(monitor.secondsSinceBytesSent(at: start))
  }

  func test_anyRequestStillSending_keepsTheSignalRecent() {
    let monitor = makeMonitor()
    let stuck = uploadTask()
    let moving = uploadTask()
    monitor.urlSession(session, didCreateTask: stuck)
    monitor.urlSession(session, didCreateTask: moving)
    advance(to: 50)
    reportSent(monitor, moving, bytes: 1 << 20)
    XCTAssertEqual(monitor.secondsSinceBytesSent(at: start.addingTimeInterval(55)), 5)
  }
}
