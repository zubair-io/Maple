// BackupProgressViewModelTests.swift — unit tests for the backup progress
// reducer in `Maple/Backup/BackupProgressViewModel.swift`.
//
// Lives in the MapleTests Xcode target (not MapleCore) because
// `BackupProgressViewModel` is declared in the app target. MapleTests is
// host-targeted on Maple.app, so `@testable import Maple_Exposure` reaches the
// (internal) `apply(_:)` reducer directly — driving it synchronously avoids
// the async event-stream plumbing.
//
// Focus: the `.failed` lifecycle fix for #723 — a retrying photo must leave
// the "Uploading now" strip (`inFlight`) instead of lingering with frozen
// byte counts, while only a *terminal* failure bumps `totalFailed`.

import MapleBackup
import XCTest

@testable import Maple_Exposure

@MainActor
final class BackupProgressViewModelTests: XCTestCase {

  private func taskID(_ phasset: String) -> BackupTaskID {
    BackupTaskID(deviceId: "test-device", phassetLocalId: phasset)
  }

  /// A transient failure that will be retried must clear the photo from the
  /// in-flight strip (so it stops reading as a frozen tile) but must NOT count
  /// as a failure — the backup is still progressing (#723).
  func testFailedWithWillRetryRemovesFromInFlightWithoutBumpingTotalFailed() {
    let vm = BackupProgressViewModel()
    let id = taskID("asset-1")

    vm.apply(.started(id))
    XCTAssertTrue(vm.inFlight.contains(where: { $0.id == id }))

    vm.apply(.failed(id, error: "NSURLErrorDomain -1005", willRetry: true))

    XCTAssertFalse(
      vm.inFlight.contains(where: { $0.id == id }),
      "a backing-off photo is pending a retry, not actively uploading")
    XCTAssertEqual(vm.totalFailed, 0, "a retrying failure is not a terminal failure")
    XCTAssertEqual(vm.lastError, "NSURLErrorDomain -1005")
  }

  /// A terminal failure (no more retries) must both remove the photo and bump
  /// the failure counter.
  func testFailedWithoutWillRetryRemovesAndBumpsTotalFailed() {
    let vm = BackupProgressViewModel()
    let id = taskID("asset-2")

    vm.apply(.started(id))
    vm.apply(.failed(id, error: "out of retries", willRetry: false))

    XCTAssertFalse(vm.inFlight.contains(where: { $0.id == id }))
    XCTAssertEqual(vm.totalFailed, 1)
    XCTAssertEqual(vm.lastError, "out of retries")
  }

  /// The retry's subsequent `.started` re-adds a fresh tile at 0% — the tile
  /// reappears actively uploading instead of staying frozen.
  func testRetryReAddsFreshInFlightTileAtZero() {
    let vm = BackupProgressViewModel()
    let id = taskID("asset-3")

    vm.apply(.started(id))
    vm.apply(.progress(id, sent: 5_000, total: 10_000))
    vm.apply(.failed(id, error: "connection lost", willRetry: true))
    XCTAssertFalse(vm.inFlight.contains(where: { $0.id == id }))

    vm.apply(.started(id))
    let tile = vm.inFlight.first(where: { $0.id == id })
    XCTAssertNotNil(tile)
    XCTAssertEqual(tile?.bytesSent, 0, "the re-added tile starts fresh, not frozen at the failed offset")
    XCTAssertEqual(tile?.bytesTotal, 0)
    XCTAssertEqual(vm.totalFailed, 0)
  }
}
