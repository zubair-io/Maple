import Foundation

/// Freeze a complete save against the document adopted by this editor.
/// A lost acknowledgement retries the identical UUID/payload, never a new action.
final class SMBModelPublication: @unchecked Sendable {
  let id = UUID().uuidString.lowercased()
  private let model: AdjustmentModel
  private let culling: CullingState
  private let createdAtMs = UInt64(Date().timeIntervalSince1970 * 1000)
  private let action: String?
  private let label: String?
  private let lock = NSLock()
  private var prepared: (expected: String?, output: String, entry: WorkflowHistoryEntry?)?

  init(
    model: AdjustmentModel, culling: CullingState, action: String? = nil, label: String? = nil
  ) throws {
    self.model = model
    self.culling = culling
    self.action = action
    self.label = label
    let checkpoint = XMPSerializer.serialize(model: model, culling: culling)
    if let entry = entry(checkpoint) {
      _ = try WorkflowSidecarCore.commit(entry, in: checkpoint)
    }
  }

  func represents(model: AdjustmentModel, culling: CullingState) -> Bool {
    self.model == model && self.culling == culling
  }

  var publishedDocument: String? { lock.withLock { prepared?.output } }

  func output(current: String?, expected: String?, variantId: String) throws -> String {
    try lock.withLock {
      if prepared == nil {
        guard current == expected else { throw changed() }
        // Scalar and semantic adjustment saves preserve source-owned removals.
        // Explicit workflow restoration uses WorkflowPublication instead (#3984).
        var savedModel = model
        savedModel.inpaintRemovals = try RemovalXMPRecords.ordinaryWriteRecords(
          current.map { Data($0.utf8) })
        let checkpoint = XMPSerializer.serialize(
          model: savedModel, culling: culling,
          metadata: current.map { XMPParser.parseMetadata($0) } ?? XmpMetadata(),
          passthrough: current.map { XMPParser.parsePassthrough($0) } ?? .empty)
        let entry = try entry(WorkflowSidecarCore.checkpoint(xmp: checkpoint))
        let output =
          try entry.map { try WorkflowSidecarCore.commit($0, in: checkpoint) }
          ?? checkpoint
        prepared = (expected, output, entry)
      }
      guard let prepared else { throw WorkflowSidecarError(message: "The checkpoint is missing.") }
      let record = try current.flatMap {
        try WorkflowSidecarCore.variantWorkflow(xmp: $0, variantId: variantId)
      }
      if let entry = prepared.entry,
        let saved = record?.history.first(where: { $0.id == id })
      {
        guard saved == entry, let current else {
          throw WorkflowSidecarError(message: "History identity belongs to another action.")
        }
        return current
      }
      if current == prepared.output { return prepared.output }
      guard current == prepared.expected else { throw changed() }
      return prepared.output
    }
  }

  private func changed() -> WorkflowSidecarError {
    WorkflowSidecarError(message: "The sidecar changed. Refresh before retrying the edit.")
  }

  private func entry(_ checkpoint: String) -> WorkflowHistoryEntry? {
    guard let action, let label else { return nil }
    return WorkflowHistoryEntry(
      id: id, createdAtMs: createdAtMs, action: action, label: label, adjustmentXmp: checkpoint)
  }
}
