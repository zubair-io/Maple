import Foundation

/// Presentation values are independent of SwiftUI and never own the backup engine.
@MainActor
enum BackupStatusPresentation {
  struct Activity: Hashable, Identifiable {
    let id: String
    let symbol: String
    let text: String
  }

  static func activities(_ progress: BackupProgressViewModel) -> [Activity] {
    var entries: [Activity] = []
    switch progress.walkPhase {
    case .enumerating:
      entries.append(.init(id: "scan", symbol: "photo.stack", text: "Scanning Photos library…"))
    case .checkingServer:
      entries.append(.init(id: "scan", symbol: "server.rack", text: "Checking server backups…"))
    case .reconciling(let checked, let total):
      entries.append(
        .init(
          id: "scan", symbol: "checkmark.arrow.trianglehead.counterclockwise",
          text: "Checking \(checked.formatted()) of \(total.formatted()) photos…"))
    case .idle, .failed: break
    }
    if let speed = progress.throughputLabel {
      entries.append(.init(id: "speed", symbol: "gauge.with.dots.needle.67percent", text: speed))
    }
    if let summary = progress.lastWalkSummary {
      entries.append(
        .init(
          id: "checked", symbol: "checkmark.circle",
          text: "Library checked \(summary.finishedAt.formatted(.relative(presentation: .named)))"))
    }
    if progress.uploadedCompanionsPendingCount > 0 {
      entries.append(
        .init(
          id: "companions", symbol: "arrow.triangle.2.circlepath",
          text:
            "Saving extra files for \(progress.uploadedCompanionsPendingCount.formatted()) photos"))
    }
    return entries.isEmpty
      ? [
        .init(
          id: "idle", symbol: "info.circle",
          text: progress.phase == .stopped
            ? "Backup stopped" : "Waiting for backup activity…")
      ]
      : entries
  }

  /// Preserve the selected category across frequent updates; advance only on the timer.
  static func next(after id: String?, in entries: [Activity]) -> Activity? {
    guard !entries.isEmpty else { return nil }
    guard let index = entries.firstIndex(where: { $0.id == id }) else { return entries.first }
    return entries[(index + 1) % entries.count]
  }

  static func tile(_ item: BackupProgressViewModel.InFlight) -> Activity {
    if let fraction = item.fractionDone {
      return .init(id: "upload", symbol: "arrow.up.circle", text: "\(Int(fraction * 100))%")
    }
    if item.preparation.hasPrefix("Downloading from iCloud") {
      let percent = item.preparation.components(separatedBy: " · ").dropFirst().first ?? ""
      return .init(id: "download", symbol: "icloud.and.arrow.down", text: percent)
    }
    return .init(id: "read", symbol: "photo", text: "")
  }

  static func tileLabel(_ item: BackupProgressViewModel.InFlight) -> String {
    if let fraction = item.fractionDone { return "Uploading, \(Int(fraction * 100)) percent" }
    return item.preparation
  }

  static func failureCount(_ progress: BackupProgressViewModel, startError: String?) -> Int {
    let photos = max(progress.issues.failureCount, progress.lastWalkSummary?.failedPermanently ?? 0)
    let scanFailed: Int = if case .failed = progress.walkPhase { 1 } else { 0 }
    return photos + scanFailed + (startError == nil ? 0 : 1)
  }
}
