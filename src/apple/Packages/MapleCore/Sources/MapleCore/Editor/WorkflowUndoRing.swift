// The editor's Undo/Redo ring as a fold over the sidecar's persisted history (#4983).
import Foundation

/// One step of the ring: the complete states it moves between.
struct WorkflowUndoStep: Equatable, Sendable {
  let description: String
  let before: AdjustmentModel
  let after: AdjustmentModel
  let checkpoint: WorkflowCheckpoint
}

struct WorkflowUndoRing: Equatable, Sendable {
  /// Oldest first; the last step is the next Undo.
  let undo: [WorkflowUndoStep]
  /// Nearest first; the first step is the next Redo.
  let redo: [WorkflowUndoStep]

  static let outsideEditLabel = "Changed outside Maple"

  private struct State {
    let label: String
    let xml: String
    let model: AdjustmentModel
  }

  /// The ring the shared core folds `xml`'s retained history into, up to `cap`
  /// steps on each side. A sidecar without history has an empty ring.
  static func make(xml: String, variantId: String, cap: Int) throws -> WorkflowUndoRing {
    guard let record = try WorkflowSidecarCore.variantWorkflow(xmp: xml, variantId: variantId),
      let head = record.history.last
    else { return WorkflowUndoRing(undo: [], redo: []) }
    let cursor = try WorkflowSidecarCore.cursor(xmp: xml)
    func state(_ id: String) throws -> State {
      guard let entry = record.history.first(where: { $0.id == id }) else {
        throw WorkflowSidecarError(message: "A history entry the cursor names is missing.")
      }
      return State(
        label: entry.label, xml: entry.adjustmentXmp,
        model: try XMPParser.parse(entry.adjustmentXmp).0)
    }
    let current = State(
      label: cursor.synced ? head.label : outsideEditLabel,
      xml: try WorkflowSidecarCore.checkpoint(xmp: xml), model: try XMPParser.parse(xml).0)
    let undoStates = try cursor.undo.suffix(cap).map(state)
    let redoStates = try cursor.redo.prefix(cap).map(state)
    return WorkflowUndoRing(
      undo: zip(undoStates, undoStates.dropFirst() + [current]).map(step),
      redo: zip([current] + redoStates, redoStates).map(step))
  }

  private static func step(_ before: State, _ after: State) -> WorkflowUndoStep {
    WorkflowUndoStep(
      description: after.label, before: before.model, after: after.model,
      checkpoint: WorkflowCheckpoint(before: before.xml, after: after.xml))
  }
}
