import XCTest

@testable import MapleBackup

final class BackupRunGateTests: XCTestCase {
  func testFreshGateMayRun() {
    XCTAssertTrue(BackupRunGate().mayRun)
  }

  func testEngineStaysDownUntilEveryHolderReleases() {
    var gate = BackupRunGate()
    let first = gate.pause()
    let second = gate.pause()

    XCTAssertFalse(gate.release(first))
    XCTAssertFalse(gate.mayRun)
    XCTAssertTrue(gate.release(second))
    XCTAssertTrue(gate.mayRun)
  }

  func testReleasingTwiceNeverUndoesAnotherHoldersPause() {
    var gate = BackupRunGate()
    let first = gate.pause()
    let second = gate.pause()

    XCTAssertFalse(gate.release(first))
    XCTAssertFalse(gate.release(first))
    XCTAssertTrue(gate.isPaused)
    XCTAssertTrue(gate.release(second))
    XCTAssertFalse(gate.release(second))
  }

  func testReleasingAPauseHeldBeforeBackgroundingDoesNotRestartTheEngine() {
    var gate = BackupRunGate()
    let hold = gate.pause()
    gate.suspend()

    XCTAssertTrue(gate.release(hold))
    XCTAssertFalse(gate.mayRun, "the app is still in the background")

    gate.resume()
    XCTAssertTrue(gate.mayRun)
  }

  func testForegroundingWhileStillPausedKeepsTheEngineDown() {
    var gate = BackupRunGate()
    gate.suspend()
    let hold = gate.pause()
    gate.resume()

    XCTAssertFalse(gate.mayRun)
    XCTAssertTrue(gate.release(hold))
    XCTAssertTrue(gate.mayRun)
  }

  func testRapidBackgroundBouncesWhilePausedChangeNothing() {
    var gate = BackupRunGate()
    let hold = gate.pause()
    for _ in 0..<5 {
      gate.suspend()
      gate.resume()
      XCTAssertFalse(gate.mayRun)
      XCTAssertTrue(gate.isPaused)
    }
    XCTAssertTrue(gate.release(hold))
    XCTAssertTrue(gate.mayRun)
  }

  func testBackgroundTaskWakeCannotRunTheBackupWhileAStitchHoldsAPause() {
    var gate = BackupRunGate()
    let hold = gate.pause()
    gate.suspend()
    gate.resume()

    XCTAssertTrue(gate.isPaused)
    XCTAssertFalse(gate.mayRun)
    _ = gate.release(hold)
  }

  func testPausesHeldAcrossASuspendAreIndependentOfTheSuspendFlag() {
    var gate = BackupRunGate()
    let hold = gate.pause()
    gate.suspend()
    gate.suspend()
    gate.resume()

    XCTAssertFalse(gate.isSuspended)
    XCTAssertTrue(gate.isPaused)
    XCTAssertTrue(gate.release(hold))
  }
}
