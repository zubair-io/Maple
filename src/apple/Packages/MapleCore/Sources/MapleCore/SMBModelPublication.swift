import Foundation

/// Freeze a complete save against the document this editor's model represents.
/// A share that moved on is merged onto by the shared core (#5828); a lost
/// acknowledgement retries the identical UUID/payload, never a new action.
final class SMBModelPublication: @unchecked Sendable {
  private struct Prepared {
    let current: String?
    let output: String
    let represented: String
    let entry: WorkflowHistoryEntry?
  }

  let id = UUID().uuidString.lowercased()
  let model: AdjustmentModel
  let culling: CullingState
  private let createdAtMs = UInt64(Date().timeIntervalSince1970 * 1000)
  private let action: String?
  private let label: String?
  private let lock = NSLock()
  private var base: String??
  private var prepared: Prepared?

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

  /// The document this save's model represents, before any merge onto the share.
  var representedDocument: String? { lock.withLock { prepared?.represented } }

  /// `base` is the document the editor's model represented when this save was first
  /// attempted; retries keep that base so a share that moved on is merged, not replaced.
  func output(current: String?, base: String?, variantId: String) throws -> String {
    try lock.withLock {
      let frozen = self.base ?? base
      self.base = frozen
      if let prepared, let entry = prepared.entry,
        let saved = try current.flatMap({
          try WorkflowSidecarCore.variantWorkflow(xmp: $0, variantId: variantId)
        })?.history.first(where: { $0.id == id })
      {
        guard saved.isSameAction(as: entry), let current else {
          throw WorkflowSidecarError(message: "History identity belongs to another action.")
        }
        return current
      }
      if let prepared, current == prepared.output || current == prepared.current {
        return prepared.output
      }
      let next = try prepare(current: current, base: frozen, variantId: variantId)
      prepared = next
      return next.output
    }
  }

  private func prepare(current: String?, base: String?, variantId: String) throws -> Prepared {
    let incoming = XMPSerializer.serialize(
      model: model, culling: culling,
      metadata: current.map { XMPParser.parseMetadata($0) } ?? XmpMetadata(),
      passthrough: current.map { XMPParser.parsePassthrough($0) } ?? .empty)
    let merged = try Self.drifted(current, from: base).map {
      try WorkflowSidecarCore.reconcile(
        base: base ?? "", current: $0, incoming: incoming,
        nowMs: UInt64(Date().timeIntervalSince1970 * 1000))
    }
    let document = merged ?? incoming
    let parentId = try WorkflowSidecarCore.headId(
      xmp: merged == nil ? current : base, variantId: variantId)
    guard let entry = try entry(WorkflowSidecarCore.checkpoint(xmp: document), parentId: parentId)
    else {
      return Prepared(current: current, output: document, represented: incoming, entry: nil)
    }
    let output = try WorkflowSidecarCore.commit(entry, in: document)
    let represented =
      try merged.map { _ in
        try WorkflowSidecarCore.commit(
          entry.holding(WorkflowSidecarCore.checkpoint(xmp: incoming)), in: incoming)
      } ?? output
    return Prepared(current: current, output: output, represented: represented, entry: entry)
  }

  /// The share's document when it holds adjustments `base` does not; a sidecar that
  /// vanished from under a save that was based on one is refused.
  private static func drifted(_ current: String?, from base: String?) throws -> String? {
    guard let current else {
      guard base == nil else {
        throw WorkflowSidecarError(
          message: "The sidecar changed. Refresh before retrying the edit.")
      }
      return nil
    }
    guard current != base, try !WorkflowSidecarCore.holdSameAdjustments(current, base) else {
      return nil
    }
    return current
  }

  private func entry(_ checkpoint: String, parentId: String = "") -> WorkflowHistoryEntry? {
    guard let action, let label else { return nil }
    return WorkflowHistoryEntry(
      id: id, createdAtMs: createdAtMs, action: action, label: label, parentId: parentId,
      writer: WorkflowContract.appleWriter, adjustmentXmp: checkpoint)
  }
}
