import MapleBackup
import SwiftUI
import XCTest

@testable import Maple_Exposure

#if canImport(UIKit)
  import UIKit
#endif

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
    status.apply(.failed(id, error: BackupQueueEvent.Coordination.anotherDevice, willRetry: true))
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
    status.apply(
      .failed(id, error: BackupQueueEvent.Coordination.waitingForNetwork, willRetry: true))
    XCTAssertEqual(status.message, "Backup is waiting for Wi-Fi or Ethernet.")
    XCTAssertFalse(status.isFailure)
    status.apply(.started(id))
    XCTAssertNil(status.message)
  }
  func testCountsAndDetailsTrackDistinctPhotosAndRecovery() {
    let status = BackupIssueStatus { _, _ in }
    let other = BackupTaskID(deviceId: "test", phassetLocalId: "other")
    status.apply(.failed(id, error: "network connection lost", willRetry: true))
    status.apply(.failed(id, error: "network connection lost", willRetry: true))
    status.apply(.failed(other, error: "network connection lost", willRetry: true))
    XCTAssertEqual(status.warningCount, 2)
    XCTAssertEqual(status.details(failures: false).first?.count, 2)
    status.apply(.failed(id, error: "network connection lost", willRetry: false))
    XCTAssertEqual(status.warningCount, 1)
    XCTAssertEqual(status.failureCount, 1)
    XCTAssertEqual(status.details(failures: true).first?.count, 1)
    status.apply(.completed(other, mapleId: "m"))
    XCTAssertEqual(status.warningCount, 0)
    XCTAssertTrue(status.details(failures: false).isEmpty)
    status.reset()
    XCTAssertEqual(status.failureCount, 0)
    XCTAssertTrue(status.details(failures: true).isEmpty)
  }

  func testRetryAfterFailureMovesPhotoBetweenCounts() {
    let status = BackupIssueStatus { _, _ in }
    status.apply(.failed(id, error: "failed", willRetry: false))
    status.apply(.failed(id, error: "timed out", willRetry: true))
    XCTAssertEqual(status.failureCount, 0)
    XCTAssertEqual(status.warningCount, 1)
    XCTAssertEqual(status.details(failures: false).first?.message, "The request timed out.")
  }

  func testActivityRotationSurvivesChangingAndRemovedEntries() {
    typealias Entry = BackupStatusPresentation.Activity
    let scan = Entry(id: "scan", symbol: "", text: "Scanning")
    let speed = Entry(id: "speed", symbol: "", text: "20 MB/s")
    let newerSpeed = Entry(id: "speed", symbol: "", text: "40 MB/s")
    XCTAssertEqual(BackupStatusPresentation.next(after: nil, in: [scan, speed]), scan)
    XCTAssertEqual(
      BackupStatusPresentation.next(after: scan.id, in: [scan, newerSpeed]), newerSpeed)
    XCTAssertEqual(BackupStatusPresentation.next(after: speed.id, in: [scan, speed]), scan)
    XCTAssertEqual(BackupStatusPresentation.next(after: scan.id, in: [speed]), speed)
    XCTAssertNil(BackupStatusPresentation.next(after: scan.id, in: []))
  }

  func testActivityTextUpdatesDynamicallyForActiveCategory() {
    let vm = BackupProgressViewModel()
    vm.setWalkPhase(.reconciling(checked: 10, total: 100))
    let activities1 = BackupStatusPresentation.activities(vm)
    let scan1 = activities1.first(where: { $0.id == "scan" })
    XCTAssertEqual(scan1?.text, "Checking 10 of 100 photos…")

    vm.setWalkPhase(.reconciling(checked: 25, total: 100))
    let activities2 = BackupStatusPresentation.activities(vm)
    let scan2 = activities2.first(where: { $0.id == "scan" })
    XCTAssertEqual(scan2?.text, "Checking 25 of 100 photos…")
  }

  func testPhotoStateIconsSeparateReadingDownloadingAndUploading() {
    let vm = BackupProgressViewModel()
    vm.apply(.started(id))
    XCTAssertEqual(BackupStatusPresentation.tile(vm.inFlight[0]).id, "read")
    XCTAssertEqual(BackupStatusPresentation.tile(vm.inFlight[0]).text, "")
    vm.apply(.preparing(id, message: "Downloading from iCloud · 37%"))
    XCTAssertEqual(BackupStatusPresentation.tile(vm.inFlight[0]).id, "download")
    XCTAssertEqual(BackupStatusPresentation.tile(vm.inFlight[0]).text, "37%")
    vm.apply(.progress(id, sent: 25, total: 100))
    XCTAssertEqual(BackupStatusPresentation.tile(vm.inFlight[0]).id, "upload")
    XCTAssertEqual(BackupStatusPresentation.tile(vm.inFlight[0]).text, "25%")
  }

  #if canImport(UIKit)
    func testPanelHeightStaysStableDuringScanDownloadAndRetry() async throws {
      let vm = BackupProgressViewModel()
      vm.setPhase(.running)
      vm.setWalkPhase(.checkingServer)
      func snapshot(_ name: String) async throws -> UIImage {
        let host = UIHostingController(
          rootView: BackupStatusPanel(progress: vm)
            .padding().frame(width: 350).background(Color(uiColor: .systemBackground)))
        let size = host.sizeThatFits(in: CGSize(width: 350, height: 1000))
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.rootViewController = host
        window.isHidden = false
        defer { window.isHidden = true }
        host.view.frame = window.bounds
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        let image = UIGraphicsImageRenderer(size: size).image { _ in
          host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        return image
      }
      let scanning = try await snapshot("Backup — checking server")
      vm.apply(.started(id))
      vm.apply(.preparing(id, message: "Downloading from iCloud · 100%"))
      vm.setWalkPhase(.reconciling(checked: 1000, total: 97000))
      let downloading = try await snapshot("Backup — downloading")
      vm.apply(.failed(id, error: "network connection lost", willRetry: true))
      let retrying = try await snapshot("Backup — warning count")
      XCTAssertEqual(scanning.size.height, downloading.size.height, accuracy: 1)
      XCTAssertEqual(scanning.size.height, retrying.size.height, accuracy: 1)
    }
  #endif

}
