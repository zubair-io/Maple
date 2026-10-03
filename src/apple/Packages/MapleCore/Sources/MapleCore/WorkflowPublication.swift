// Immutable product commands over the existing portable workflow contract (#4062).
import Foundation

public enum WorkflowPublication: Equatable, Sendable {
  case snapshot(expectedXmp: String?, initialXmp: String?, snapshot: WorkflowSnapshot)
  case restore(expectedXmp: String, entry: WorkflowHistoryEntry)
  case replay(expectedXmp: String, entry: WorkflowHistoryEntry)

  /// Recognize an accepted command even when its acknowledgement was lost.
  /// The immutable UUID must identify the identical payload, never a different edit.
  func acknowledged(in current: String?) throws -> Bool {
    guard let current else { return false }
    let record = try WorkflowSidecarCore.primaryWorkflow(xmp: current)
    switch self {
    case .snapshot(_, _, let snapshot):
      guard let saved = record?.snapshots.first(where: { $0.id == snapshot.id }) else {
        return false
      }
      guard saved == snapshot else {
        throw failure("Snapshot identity already belongs to another checkpoint.")
      }
    case .restore(_, let entry), .replay(_, let entry):
      guard let saved = record?.history.first(where: { $0.id == entry.id }) else { return false }
      guard saved == entry else {
        throw failure("History identity already belongs to another action.")
      }
    }
    return true
  }

  func output(current: String?) throws -> String {
    if try acknowledged(in: current), let current { return current }
    guard current == expectedXmp else {
      throw failure("The sidecar changed. Refresh snapshots and history before trying again.")
    }
    if let current { _ = try WorkflowSidecarCore.primaryWorkflow(xmp: current) }
    switch self {
    case .snapshot(_, let initial, let snapshot):
      guard let xml = current ?? initial else {
        throw failure("The initial checkpoint is missing.")
      }
      _ = try WorkflowSidecarCore.primaryWorkflow(xmp: xml)
      return try WorkflowSidecarCore.snapshot(snapshot, in: xml)
    case .restore(_, let entry):
      guard let current else { throw failure("The sidecar is missing. Restore it before editing.") }
      let restored = try WorkflowSidecarCore.restore(entry, in: current)
      // The shared converter may expand a self-closing Description to carry
      // Workflow. Its owned envelope change is not a user edit.
      return try WorkflowSidecarCore.checkpoint(xmp: restored)
        == WorkflowSidecarCore.checkpoint(xmp: current)
        ? current : restored
    case .replay(_, let entry):
      guard let current else { throw failure("The sidecar is missing. Restore it before editing.") }
      let record = try WorkflowSidecarCore.primaryWorkflow(xmp: current)
      let candidate =
        try record.map { try WorkflowSidecarCore.embed($0, in: entry.adjustmentXmp) }
        ?? entry.adjustmentXmp
      return try WorkflowSidecarCore.commit(entry, in: candidate)
    }
  }

  var expectedXmp: String? {
    switch self {
    case .snapshot(let expected, _, _): return expected
    case .restore(let expected, _), .replay(let expected, _): return expected
    }
  }

  private func failure(_ message: String) -> WorkflowSidecarError {
    WorkflowSidecarError(message: message)
  }
}

/// Read and publication share the same queue and actual primary as ordinary saves.
public protocol WorkflowSidecarStoreProtocol: SemanticSidecarStoreProtocol {
  func readWorkflowXML() async throws -> String?
  func publishWorkflow(_ command: WorkflowPublication) async throws -> String
}
