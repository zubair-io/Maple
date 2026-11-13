import CryptoKit
import Foundation
import os

/// One line per Preview-page load event (#5432), to Console at `.notice`
/// and to the OTel exporter through `ObservabilityController`.
public enum PreviewLoadLog {
  public enum Stage: String, Sendable {
    case seed, thumb, refine
    /// The network fetch underneath a refine (`CloudSource.previewOutcome`).
    case fetch
  }

  public enum Event: String, Sendable {
    case start, finish, fail, cancel, activate, deactivate
  }

  private static let logger = Logger(subsystem: "app.justmaple.aperture", category: "preview-load")

  public static func record(
    stage: Stage,
    event: Event,
    assetID: String,
    sourceKind: String,
    targetPx: Int? = nil,
    bytes: Int? = nil,
    elapsedMs: Int? = nil,
    reason: String? = nil
  ) {
    let line = message(
      stage: stage, event: event, assetID: assetID, sourceKind: sourceKind,
      targetPx: targetPx, bytes: bytes, elapsedMs: elapsedMs, reason: reason)
    logger.notice("\(line, privacy: .public)")
    Task { @MainActor in ObservabilityController.shared.log(.info, line) }
  }

  static func message(
    stage: Stage,
    event: Event,
    assetID: String,
    sourceKind: String,
    targetPx: Int?,
    bytes: Int?,
    elapsedMs: Int?,
    reason: String?
  ) -> String {
    let fields: [String?] = [
      "preview",
      "stage=\(stage.rawValue)",
      "event=\(event.rawValue)",
      "asset=\(redactedAssetID(assetID))",
      "source=\(sourceKind)",
      targetPx.map { "target_px=\($0)" },
      bytes.map { "bytes=\($0)" },
      elapsedMs.map { "elapsed_ms=\($0)" },
      reason.map { "reason=\"\($0)\"" },
    ]
    return fields.compactMap { $0 }.joined(separator: " ")
  }

  /// Cloud ids are `fs:<absPath>` and can name private folders, so any id
  /// carrying a path is logged as a stable hash plus its extension.
  /// Opaque ids (catalog ids, UUIDs, PhotoKit identifiers) pass through.
  static func redactedAssetID(_ id: String) -> String {
    guard id.contains("/") else { return id }
    let digest = SHA256.hash(data: Data(id.utf8))
    let hex = digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    let ext = (id as NSString).pathExtension.lowercased()
    return ext.isEmpty ? "path#\(hex)" : "path#\(hex).\(ext)"
  }

  public static func milliseconds(since start: ContinuousClock.Instant) -> Int {
    let elapsed = ContinuousClock.now - start
    let (seconds, attoseconds) = elapsed.components
    return Int(seconds) * 1_000 + Int(attoseconds / 1_000_000_000_000_000)
  }
}
