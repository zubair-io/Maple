// BackupProgressViewModelTests.swift — unit tests for the backup progress
// reducer in `Maple/Backup/BackupProgressViewModel.swift`.
//
// Lives in the MapleTests Xcode target (not MapleCore) because
// `BackupProgressViewModel` is declared in the app target. MapleTests is
// host-targeted on Maple Exposure.app, so `@testable import Maple_Exposure` reaches the
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

  // MARK: - Walk summary → "All photos backed up" (#3097)

  /// A walk that enumerated a fully-backed-up library (enqueued nothing) must
  /// flip the empty-state text to a completion summary — the old behaviour
  /// ("No photos queued") read as a broken backup.
  func testWalkSummaryWithNothingEnqueuedShowsAllBackedUp() {
    let vm = BackupProgressViewModel()
    XCTAssertEqual(vm.progressLabel, "No photos queued")

    vm.recordWalkSummary(BackupProgressViewModel.WalkSummary(
      enumerated: 97_312, enqueued: 0, failedPermanently: 0, finishedAt: Date()))

    XCTAssertTrue(vm.isAllBackedUp)
    XCTAssertEqual(vm.progressLabel, "All photos backed up · \(97_312.formatted()) photos")
    XCTAssertEqual(vm.fractionDone, 1.0, "completed backup renders a full bar")
  }

  /// A walk that enqueued work is not a completion — the label must stay on
  /// the counting path once `.enqueued` events arrive.
  func testWalkSummaryWithEnqueuedWorkKeepsCountingLabel() {
    let vm = BackupProgressViewModel()
    vm.recordWalkSummary(BackupProgressViewModel.WalkSummary(
      enumerated: 100, enqueued: 2, failedPermanently: 0, finishedAt: Date()))
    XCTAssertFalse(vm.isAllBackedUp)
    XCTAssertEqual(vm.progressLabel, "No photos queued",
                   "no .enqueued events observed yet — still the cold empty state")

    vm.apply(.enqueued(BackupTask(id: taskID("new-1"), state: .pending, priority: .background)))
    vm.apply(.enqueued(BackupTask(id: taskID("new-2"), state: .pending, priority: .background)))
    XCTAssertEqual(vm.progressLabel, "0 of 2 photos")
    XCTAssertEqual(vm.fractionDone, 0.0)
  }

  /// Live queue events outrank a stale completion summary: a new capture
  /// enqueued after an "all backed up" walk switches back to counting.
  func testEnqueuedEventOverridesAllBackedUpSummary() {
    let vm = BackupProgressViewModel()
    vm.recordWalkSummary(BackupProgressViewModel.WalkSummary(
      enumerated: 97_312, enqueued: 0, failedPermanently: 0, finishedAt: Date()))
    XCTAssertTrue(vm.isAllBackedUp)

    vm.apply(.enqueued(BackupTask(id: taskID("fresh-capture"), state: .pending, priority: .background)))

    XCTAssertFalse(vm.isAllBackedUp)
    XCTAssertEqual(vm.progressLabel, "0 of 1 photos")
  }

  /// An enumerated-zero walk (e.g. limited Photos access with nothing
  /// selected) is NOT "all backed up" — there was nothing to check.
  func testWalkSummaryWithZeroEnumeratedIsNotAllBackedUp() {
    let vm = BackupProgressViewModel()
    vm.recordWalkSummary(BackupProgressViewModel.WalkSummary(
      enumerated: 0, enqueued: 0, failedPermanently: 0, finishedAt: Date()))
    XCTAssertFalse(vm.isAllBackedUp)
    XCTAssertEqual(vm.progressLabel, "No photos queued")
  }

  /// The permanently-failed count rides along on the summary so the panel can
  /// caption it ("13 failed permanently").
  func testWalkSummaryExposesPermanentFailures() {
    let vm = BackupProgressViewModel()
    vm.recordWalkSummary(BackupProgressViewModel.WalkSummary(
      enumerated: 97_312, enqueued: 0, failedPermanently: 13, finishedAt: Date()))
    XCTAssertTrue(vm.isAllBackedUp)
    XCTAssertEqual(vm.lastWalkSummary?.failedPermanently, 13)
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
