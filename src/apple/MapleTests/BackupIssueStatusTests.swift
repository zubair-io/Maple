import MapleBackup
import XCTest

@testable import Maple_Exposure

@MainActor
final class BackupIssueStatusTests: XCTestCase {
  private let id = BackupTaskID(deviceId: "test", phassetLocalId: "photo")

  func testRetryLogsWarningWithoutExposingDiagnosticDump() {
    var records: [(BackupIssueStatus.Severity, String)] = []
    let status = BackupIssueStatus { records.append(($0, $1)) }
    let diagnostic = "NSURLErrorDomain -1005 UserInfo={network connection lost}"
    status.apply(.failed(id, error: diagnostic, willRetry: true))
    XCTAssertEqual(records.first?.0, .warning)
    XCTAssertTrue(records.first?.1.contains(diagnostic) == true)
    XCTAssertEqual(status.message, "Retrying a photo. Backup will continue automatically.")
    XCTAssertFalse(status.isFailure)
    status.apply(.completed(id, mapleId: "m"))
    XCTAssertNil(status.message)
  }

  func testExhaustedRetriesLogErrorAndStayVisibleDuringOtherRetries() {
    var records: [(BackupIssueStatus.Severity, String)] = []
    let status = BackupIssueStatus { records.append(($0, $1)) }
    status.apply(.failed(id, error: "terminal details", willRetry: false))
    XCTAssertEqual(records.first?.0, .error)
    XCTAssertTrue(records.first?.1.contains("terminal details") == true)
    status.apply(
      .failed(.init(deviceId: "test", phassetLocalId: "other"), error: "retry", willRetry: true))
    XCTAssertTrue(status.isFailure)
    XCTAssertEqual(status.message, "1 photo couldn't be backed up. Stop and start backup to retry.")
  }

  func testPeerCoordinationLogsInfoWithoutWarning() {
    var severity: BackupIssueStatus.Severity?
    let status = BackupIssueStatus {
      severity = $0
      _ = $1
    }
    status.apply(.failed(id, error: "temporary network failure", willRetry: true))
    status.apply(.failed(id, error: "busy elsewhere", willRetry: true))
    XCTAssertEqual(severity, .info)
    XCTAssertNil(status.message)
  }

  func testStopClearsRetryWarningAndRestartClearsPriorFailures() {
    let status = BackupIssueStatus { _, _ in }
    status.apply(.failed(id, error: "retry", willRetry: true))
    status.clearRetries()
    XCTAssertNil(status.message)
    status.apply(.failed(id, error: "failed", willRetry: false))
    status.clearRetries()
    XCTAssertTrue(status.isFailure)
    status.reset()
    XCTAssertNil(status.message)
  }

  func testCancelledPhotoClearsItsWarning() {
    let status = BackupIssueStatus { _, _ in }
    status.apply(.failed(id, error: "retry", willRetry: true))
    status.apply(.cancelled(id))
    XCTAssertNil(status.message)
  }

  func testProgressReducerClearsRecoveredWarning() {
    let vm = BackupProgressViewModel()
    vm.apply(.failed(id, error: "network connection lost", willRetry: true))
    XCTAssertNotNil(vm.issues.message)
    XCTAssertEqual(vm.totalFailed, 0)
    vm.apply(.completed(id, mapleId: "m"))
    XCTAssertNil(vm.issues.message)
  }

  func testNetworkWaitExplainsConstraint() {
    let status = BackupIssueStatus { _, _ in }
    status.apply(.failed(id, error: "Waiting for Wi-Fi or Ethernet", willRetry: true))
    XCTAssertEqual(status.message, "Backup is waiting for Wi-Fi or Ethernet.")
    XCTAssertFalse(status.isFailure)
    status.apply(.started(id))
    XCTAssertNil(status.message)
  }
}
