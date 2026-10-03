import Foundation

/// Freeze the complete checkpoint at the first owned publication boundary.
/// A lost acknowledgement retries the identical UUID/payload, never a new action.
final class SMBSemanticPublication: @unchecked Sendable {
  let id = UUID().uuidString.lowercased()
  private let model: AdjustmentModel
  private let culling: CullingState
  private let createdAtMs = UInt64(Date().timeIntervalSince1970 * 1000)
  private let action: String
  private let label: String
  private let lock = NSLock()
  private var prepared: (expected: String?, entry: WorkflowHistoryEntry)?

  init(model: AdjustmentModel, culling: CullingState, action: String, label: String) throws {
    self.model = model
    self.culling = culling
    self.action = action
    self.label = label
    let checkpoint = XMPSerializer.serialize(model: model, culling: culling)
    _ = try WorkflowSidecarCore.commit(entry(checkpoint), in: checkpoint)
  }

  func represents(model: AdjustmentModel, culling: CullingState) -> Bool {
    self.model == model && self.culling == culling
  }

  func output(current: String?, variantId: String) throws -> String {
    try lock.withLock {
      if prepared == nil {
        let checkpoint = XMPSerializer.serialize(
          model: model, culling: culling,
          metadata: current.map { XMPParser.parseMetadata($0) } ?? XmpMetadata(),
          passthrough: current.map { XMPParser.parsePassthrough($0) } ?? .empty)
        prepared = (current, entry(try WorkflowSidecarCore.checkpoint(xmp: checkpoint)))
      }
      guard let prepared else { throw WorkflowSidecarError(message: "The checkpoint is missing.") }
      let record = try current.flatMap {
        try WorkflowSidecarCore.variantWorkflow(xmp: $0, variantId: variantId)
      }
      if let saved = record?.history.first(where: { $0.id == id }) {
        guard saved == prepared.entry, let current else {
          throw WorkflowSidecarError(message: "History identity belongs to another action.")
        }
        return current
      }
      guard current == prepared.expected else {
        throw WorkflowSidecarError(
          message: "The sidecar changed. Refresh before retrying the edit.")
      }
      let checkpoint = prepared.entry.adjustmentXmp
      let candidate =
        try record.map { try WorkflowSidecarCore.embed($0, in: checkpoint) } ?? checkpoint
      return try WorkflowSidecarCore.commit(prepared.entry, in: candidate)
    }
  }

  private func entry(_ checkpoint: String) -> WorkflowHistoryEntry {
    WorkflowHistoryEntry(
      id: id, createdAtMs: createdAtMs, action: action, label: label, adjustmentXmp: checkpoint)
  }
}
