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
  private var reasons: [BackupTaskID: String] = [:]
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

  var warningCount: Int { retrying.count }
  var failureCount: Int { failed.count }

  struct Detail: Identifiable {
    let id: String
    let count: Int
    let message: String
  }

  func details(failures: Bool) -> [Detail] {
    let ids = failures ? failed : retrying
    let grouped = Dictionary(grouping: ids) { reasons[$0] ?? "The photo could not be processed." }
    return grouped.keys.sorted().map { reason in
      Detail(id: reason, count: grouped[reason]?.count ?? 0, message: reason)
    }
  }

  /// Raw errors remain in diagnostic logs; the detail sheet explains actionable causes.
  private static func explanation(_ error: String) -> String {
    let text = error.lowercased()
    if error == BackupQueueEvent.Coordination.waitingForNetwork {
      return "Waiting for Wi-Fi or Ethernet."
    }
    if text.contains("icloud") { return "The original could not be downloaded from iCloud." }
    if text.contains("timed out") || text.contains("timeout") || text.contains("-1001") {
      return "The request timed out."
    }
    if text.contains("network") || text.contains("connection") || text.contains("offline") {
      return "The connection to the backup server was interrupted."
    }
    return "The photo could not be processed. More information is available in diagnostic logs."
  }

  func apply(_ event: BackupQueueEvent) {
    switch event {
    case .failed(let id, let error, let willRetry):
      // Peer coordination is routine, not an upload failure.
      if willRetry && error == BackupQueueEvent.Coordination.anotherDevice {
        retrying.remove(id)
        reasons.removeValue(forKey: id)
        waitingForNetwork.remove(id)
        report(.info, "Backup deferred: another device is uploading this photo.")
        return
      }
      waitingForNetwork.remove(id)
      reasons[id] = Self.explanation(error)
      report(
        willRetry ? .warning : .error,
        "Backup \(willRetry ? "will retry" : "failed after retries") [photo=\(id.phassetLocalId)]: \(error)"
      )
      if willRetry {
        failed.remove(id)
        retrying.insert(id)
        if error == BackupQueueEvent.Coordination.waitingForNetwork { waitingForNetwork.insert(id) }
      } else {
        retrying.remove(id)
        failed.insert(id)
      }
    case .started(let id):
      if waitingForNetwork.remove(id) != nil {
        retrying.remove(id)
        reasons.removeValue(forKey: id)
      }
    case .completed(let id, _), .cancelled(let id):
      reasons.removeValue(forKey: id)
      retrying.remove(id)
      failed.remove(id)
      waitingForNetwork.remove(id)
    default: break
    }
  }

  func clearRetries() {
    for id in retrying { reasons.removeValue(forKey: id) }
    retrying.removeAll()
    waitingForNetwork.removeAll()
  }
  func reset() {
    clearRetries()
    failed.removeAll()
    reasons.removeAll()
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
