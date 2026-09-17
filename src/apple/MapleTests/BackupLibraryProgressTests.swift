import MapleBackup
import XCTest

@testable import Maple

@MainActor
final class BackupLibraryProgressTests: XCTestCase {
  private func id(_ photo: String) -> BackupTaskID {
    .init(deviceId: "d", phassetLocalId: photo)
  }

  func testPriorBackupsCountBeforeAnySessionUploadCompletes() {
    let vm = BackupProgressViewModel()
    vm.recordLibrarySnapshot(photoIDs: ["a", "b", "c"], backedUpIDs: ["a", "b"])
    XCTAssertEqual(vm.totalCompleted, 0)
    XCTAssertEqual(vm.progressLabel, "2 of 3 photos backed up")
    XCTAssertEqual(vm.fractionDone, 2.0 / 3.0, accuracy: 0.0001)
    XCTAssertFalse(vm.isAllBackedUp)
  }

  func testLiveCompletionAndServerRecordCountOnlyOnce() {
    let vm = BackupProgressViewModel()
    vm.recordLibrarySnapshot(photoIDs: ["a", "b"], backedUpIDs: ["a"])
    vm.apply(.completed(id("a"), mapleId: "m"))
    XCTAssertEqual(vm.progressLabel, "1 of 2 photos backed up")
    vm.apply(.completed(id("b"), mapleId: "n"))
    vm.apply(.completed(id("b"), mapleId: "n"))
    XCTAssertTrue(vm.isAllBackedUp)
    XCTAssertEqual(vm.totalCompleted, 2)
    XCTAssertEqual(vm.fractionDone, 1)
  }

  func testStaleScanPreservesCompletionReceivedDuringAwait() {
    let vm = BackupProgressViewModel()
    vm.apply(.completed(id("a"), mapleId: "m"))
    vm.recordLibrarySnapshot(photoIDs: ["a", "b"], backedUpIDs: [])
    XCTAssertEqual(vm.progressLabel, "1 of 2 photos backed up")
  }

  func testSnapshotExcludesOtherLibrariesAndRemovedPhotos() {
    let vm = BackupProgressViewModel()
    vm.recordLibrarySnapshot(photoIDs: ["a", "b"], backedUpIDs: ["a", "other"])
    XCTAssertEqual(vm.progressLabel, "1 of 2 photos backed up")
    vm.recordLibrarySnapshot(photoIDs: ["b"], backedUpIDs: ["a", "other"])
    XCTAssertEqual(vm.progressLabel, "0 of 1 photos backed up")
    XCTAssertEqual(vm.fractionDone, 0)
  }

  func testNewQueuedPhotoExpandsLibraryTotal() {
    let vm = BackupProgressViewModel()
    vm.recordLibrarySnapshot(photoIDs: ["a"], backedUpIDs: ["a"])
    vm.apply(.enqueued(.init(id: id("b"), state: .pending, priority: .background)))
    XCTAssertEqual(vm.progressLabel, "1 of 2 photos backed up")
  }

  func testRestartWaitsForNewSnapshotInsteadOfReusingPreviousDestination() async {
    let vm = BackupProgressViewModel()
    vm.recordLibrarySnapshot(photoIDs: ["a"], backedUpIDs: ["a"])
    await vm.start(queue: InProcessBackupQueue())
    defer { vm.stop() }
    XCTAssertFalse(vm.isAllBackedUp)
    XCTAssertEqual(vm.fractionDone, 0)
    vm.recordLibrarySnapshot(photoIDs: ["a", "b"], backedUpIDs: ["a"])
    XCTAssertEqual(vm.progressLabel, "1 of 2 photos backed up")
  }

  func testHundredThousandPhotoSnapshotIncludesExistingBackups() {
    let vm = BackupProgressViewModel()
    let ids = Set((0..<100000).map(String.init))
    vm.recordLibrarySnapshot(photoIDs: ids, backedUpIDs: Set((0..<90000).map(String.init)))
    XCTAssertEqual(vm.fractionDone, 0.9, accuracy: 0.0001)
    vm.apply(.completed(id("90000"), mapleId: "m"))
    XCTAssertEqual(vm.fractionDone, 0.90001, accuracy: 0.000001)
  }
}
