// DownloadProgressTests.swift — unit coverage for the cloud-open download
// progress sink (#822).
import XCTest
@testable import MapleCore

@MainActor
final class DownloadProgressTests: XCTestCase {

  func test_fraction_nilUntilTotalKnown() {
    let p = DownloadProgress()
    XCTAssertNil(p.fraction, "no total → indeterminate")
    p.report(received: 100, total: nil)
    XCTAssertNil(p.fraction, "still no total → still indeterminate")
  }

  func test_fraction_seededFromCatalogSize() {
    let p = DownloadProgress(expectedBytes: 1000)
    p.begin(expectedBytes: 1000)
    p.report(received: 250, total: nil)
    XCTAssertEqual(p.fraction ?? -1, 0.25, accuracy: 0.0001,
                   "fraction tracks the seeded catalog total before headers land")
  }

  func test_report_serverContentLengthSupersedesSeed() {
    let p = DownloadProgress(expectedBytes: 1000)
    p.begin(expectedBytes: 1000)
    // Server's Content-Length differs from the catalog estimate — adopt it.
    p.report(received: 200, total: 800)
    XCTAssertEqual(p.expectedBytes, 800)
    XCTAssertEqual(p.fraction ?? -1, 0.25, accuracy: 0.0001)
  }

  func test_fraction_clampedToOne() {
    let p = DownloadProgress(expectedBytes: 100)
    p.begin(expectedBytes: 100)
    // A re-encoding proxy can stream more bytes than Content-Length claimed.
    p.report(received: 150, total: 100)
    XCTAssertEqual(p.fraction ?? -1, 1.0, accuracy: 0.0001,
                   "fraction must never exceed 1.0")
  }

  func test_lifecycle_isDownloadingFlag() {
    let p = DownloadProgress(expectedBytes: 100)
    XCTAssertFalse(p.isDownloading, "not downloading before begin()")
    p.begin(expectedBytes: 100)
    XCTAssertTrue(p.isDownloading)
    p.report(received: 50, total: 100)
    XCTAssertTrue(p.isDownloading)
    p.finish()
    XCTAssertFalse(p.isDownloading, "finish() flips the flag so the editor hides the bar")
    // Byte counts survive finish() so a "100%" frame is possible.
    XCTAssertEqual(p.receivedBytes, 50)
  }

  func test_begin_resetsReceivedAndKeepsPositiveTotal() {
    let p = DownloadProgress(expectedBytes: 500)
    p.begin(expectedBytes: 500)
    p.report(received: 400, total: 500)
    // A second begin (e.g. a retry) resets the byte counter.
    p.begin(expectedBytes: 500)
    XCTAssertEqual(p.receivedBytes, 0)
    XCTAssertEqual(p.expectedBytes, 500)
    // A non-positive total never overwrites a known one.
    p.begin(expectedBytes: nil)
    XCTAssertEqual(p.expectedBytes, 500)
  }

  func test_bytesPerSecond_runningAverageSinceBegin() {
    let start = Date(timeIntervalSince1970: 1_000_000)
    let p = DownloadProgress()
    // No report yet → nil regardless of elapsed time.
    p.begin(expectedBytes: 10_000, at: start)
    XCTAssertNil(p.bytesPerSecond(asOf: start.addingTimeInterval(5)),
                 "no bytes received yet → no rate")

    // 500 bytes in, 5 seconds elapsed → 100 B/s exactly.
    p.report(received: 500, total: nil)
    XCTAssertEqual(p.bytesPerSecond(asOf: start.addingTimeInterval(5)) ?? -1,
                   100.0, accuracy: 0.001)

    // 2500 bytes in, 10 seconds elapsed → 250 B/s.
    p.report(received: 2_500, total: nil)
    XCTAssertEqual(p.bytesPerSecond(asOf: start.addingTimeInterval(10)) ?? -1,
                   250.0, accuracy: 0.001)
  }

  func test_bytesPerSecond_nilInsideFirstHundredMs() {
    let start = Date(timeIntervalSince1970: 1_000_000)
    let p = DownloadProgress()
    p.begin(expectedBytes: 10_000, at: start)
    p.report(received: 50, total: nil)
    // Inside the 100ms suppression window — single-chunk samples skew wildly.
    XCTAssertNil(p.bytesPerSecond(asOf: start.addingTimeInterval(0.05)))
    XCTAssertNil(p.bytesPerSecond(asOf: start.addingTimeInterval(0.0999)))
    // At exactly 100ms the rate becomes meaningful.
    XCTAssertEqual(p.bytesPerSecond(asOf: start.addingTimeInterval(0.1)) ?? -1,
                   500.0, accuracy: 0.001)
  }
}
