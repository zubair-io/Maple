import MapleBackup
import MapleCore
import OSLog
import Observation

/// User-facing backup problems, separate from detailed diagnostic messages.
@MainActor
@Observable
final class BackupIssueStatus {
  private static let logger = Logger(
    subsystem: "app.justmaple.aperture", category: "Backup.Diagnostics")

  enum Severity: Equatable { case info, warning, error }
  private var retrying: Set<BackupTaskID> = []
  private var waitingForNetwork: Set<BackupTaskID> = []
  private var failed: Set<BackupTaskID> = []
  private let report: (Severity, String) -> Void

  init(report: @escaping (Severity, String) -> Void = BackupIssueStatus.log) {
    self.report = report
  }

  var isFailure: Bool { !failed.isEmpty }
  var message: String? {
    if !failed.isEmpty {
      let photos =
        failed.count == 1 ? "1 photo couldn't" : "\(failed.count.formatted()) photos couldn't"
      return "\(photos) be backed up. Stop and start backup to retry."
    }
    if !waitingForNetwork.isEmpty {
      return "Backup is waiting for Wi-Fi or Ethernet."
    }
    guard !retrying.isEmpty else { return nil }
    return
      "Retrying \(retrying.count == 1 ? "a photo" : "\(retrying.count.formatted()) photos"). Backup will continue automatically."
  }

  func apply(_ event: BackupQueueEvent) {
    switch event {
    case .failed(let id, let error, let willRetry):
      // Peer coordination is routine, not an upload failure.
      if willRetry && error == BackupQueueEvent.Coordination.anotherDevice {
        retrying.remove(id)
        waitingForNetwork.remove(id)
        report(.info, "Backup deferred: another device is uploading this photo.")
        return
      }
      waitingForNetwork.remove(id)
      report(
        willRetry ? .warning : .error,
        "Backup \(willRetry ? "will retry" : "failed after retries") [photo=\(id.phassetLocalId)]: \(error)"
      )
      if willRetry {
        retrying.insert(id)
        if error == BackupQueueEvent.Coordination.waitingForNetwork { waitingForNetwork.insert(id) }
      } else {
        retrying.remove(id)
        failed.insert(id)
      }
    case .started(let id):
      if waitingForNetwork.remove(id) != nil { retrying.remove(id) }
    case .completed(let id, _), .cancelled(let id):
      retrying.remove(id)
      failed.remove(id)
      waitingForNetwork.remove(id)
    default: break
    }
  }

  func clearRetries() {
    retrying.removeAll()
    waitingForNetwork.removeAll()
  }
  func reset() {
    clearRetries()
    failed.removeAll()
  }

  static func log(_ severity: Severity, _ details: String) {
    switch severity {
    case .info: logger.info("\(details, privacy: .public)")
    case .warning: logger.warning("\(details, privacy: .public)")
    case .error: logger.error("\(details, privacy: .public)")
    }
    let level: ObservabilityLogLevel =
      switch severity {
      case .info: .info
      case .warning: .warning
      case .error: .error
      }
    ObservabilityController.shared.log(level, details)
  }
}
