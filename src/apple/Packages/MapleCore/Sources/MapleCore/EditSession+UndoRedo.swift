// EditSession+UndoRedo.swift — the editor's bounded transaction ring
// (#2432; originally the whole-model snapshot ring split out of
// `EditSession.swift` for the file-size budget, #1153).
//
// Every committed editor action is ONE `EditTransaction`: `beginEdit`
// opens it (capturing the model as `before`), the gesture or discrete edit
// mutates `model` (preview-only ticks — render + coalesced sidecar write,
// no history), and `endEdit` closes it: the diff is computed, a no-op is
// dropped, otherwise the transaction is pushed onto the undo ring, handed
// to the sidecar store, and announced. A still-open transaction is closed
// by the next boundary (`beginEdit`, `undo`, `redo`, `endEdit`,
// `flushPendingSidecarWrite`), so a caller that only knows the START of
// a gesture (the drag bar's touch-down `commit()`) still produces exactly
// one entry.
//
// Mirrors the web `EditorStateService` ring: cap at `undoStackCap` with a
// FIFO drop off the bottom, and a symmetric cap on the redo side.

import Foundation

extension EditSession {
  /// Ring-buffer cap on the undo/redo stacks. S5 Editor (#625) bounds
  /// the editor's undo history to 32 entries per spec §4; older entries
  /// roll off the bottom (FIFO drop on push). The same cap is honored
  /// on `redo()` to keep the two stacks symmetric.
  public static let undoStackCap: Int = 32

  /// True when an undo entry exists OR the open transaction has already
  /// moved the model (it will become one at the next boundary).
  public var canUndo: Bool {
    guard !workflow.isBusy, !isSavingRemoval else { return false }
    if !transactions.undoStack.isEmpty { return true }
    guard let pending = transactions.pending else { return false }
    return pending.before != model
  }

  public var canRedo: Bool {
    !workflow.isBusy && !isSavingRemoval && !transactions.redoStack.isEmpty
  }

  /// Monotonic edit identity, including edit → undo back to the same model.
  public var editRevision: UInt64 { transactions.nextID }

  /// Open a transaction before a user gesture or discrete edit. Closes
  /// any transaction still open (recording it if it changed anything) so
  /// two consecutive gestures never merge. Back-compatible default kind
  /// for the app's per-slider `commit()` sites.
  public func beginEdit(
    kind: EditTransaction.Kind = .adjustment, description: String = "Adjustment"
  ) {
    guard !workflow.isBusy, !isSavingRemoval else { return }
    endEdit()
    transactions.nextID &+= 1
    transactions.pending = PendingEdit(
      id: transactions.nextID, kind: kind, description: description, before: model)
    transactions.redoStack.removeAll()
  }

  /// Close the open transaction. A no-op transaction (model unchanged)
  /// records nothing; anything else becomes exactly one undo entry.
  public func endEdit() {
    guard !workflow.isBusy, !isSavingRemoval else { return }
    guard let pending = transactions.pending else { return }
    transactions.pending = nil
    guard
      let tx = EditTransaction.make(
        id: pending.id, kind: pending.kind, description: pending.description,
        before: pending.before, after: model)
    else { return }
    record(tx)
    scheduleSemanticSidecarCommit(
      model: tx.after, culling: culling, action: workflowAction(for: tx.kind), label: tx.description
    )
    announcer.announce(tx.description)
  }

  /// Abandon the open transaction without recording it. The model keeps
  /// whatever the preview ticks wrote (matches the web `cancelGesture`).
  public func cancelEdit() {
    transactions.pending = nil
  }

  public func undo() {
    guard !workflow.isBusy, !isSavingRemoval else { return }
    endEdit()
    guard let tx = transactions.undoStack.last else { return }
    if tx.checkpoint != nil {
      workflow.beginReplay(session: self, transaction: tx, undo: true)
      return
    }
    if tx.before.inpaintRemovals != tx.after.inpaintRemovals {
      startRemovalHistory(target: tx.before, transition: .undo(tx))
      return
    }
    transactions.undoStack.removeLast()
    transactions.redoStack.append(tx)
    trim(&transactions.redoStack)
    transactions.nextID &+= 1
    model = rebindingBrushRasters(live: model, restored: tx.before)
    scheduleSemanticSidecarCommit(
      model: tx.before, culling: culling, action: "undo", label: "Undo \(tx.description)")
    lastCommittedTransaction = tx
    announcer.announce("Undo \(tx.description)")
  }

  public func redo() {
    guard !workflow.isBusy, !isSavingRemoval else { return }
    endEdit()
    guard let tx = transactions.redoStack.last else { return }
    if tx.checkpoint != nil {
      workflow.beginReplay(session: self, transaction: tx, undo: false)
      return
    }
    if tx.before.inpaintRemovals != tx.after.inpaintRemovals {
      startRemovalHistory(target: tx.after, transition: .redo(tx))
      return
    }
    transactions.redoStack.removeLast()
    transactions.undoStack.append(tx)
    trim(&transactions.undoStack)
    transactions.nextID &+= 1
    model = rebindingBrushRasters(live: model, restored: tx.after)
    scheduleSemanticSidecarCommit(
      model: tx.after, culling: culling, action: "redo", label: "Redo \(tx.description)")
    lastCommittedTransaction = tx
    announcer.announce("Redo \(tx.description)")
  }

  public func resetToOriginal() {
    guard !workflow.isBusy, !isSavingRemoval else { return }
    activeBrushStroke = nil
    commitModelSnapshot(
      rebindingBrushRasters(live: model, restored: originalModel),
      kind: .reset, description: "Reset to original")
  }

  /// The recorded transactions, oldest first. Test / diagnostics seam.
  public var undoHistory: [EditTransaction] { transactions.undoStack }

  func record(_ tx: EditTransaction) {
    transactions.undoStack.append(tx)
    trim(&transactions.undoStack)
    lastCommittedTransaction = tx
  }

  func trim(_ stack: inout [EditTransaction]) {
    if stack.count > Self.undoStackCap {
      stack.removeFirst(stack.count - Self.undoStackCap)
    }
  }
}

/// An open, not-yet-recorded transaction.
struct PendingEdit {
  let id: UInt64
  let kind: EditTransaction.Kind
  let description: String
  let before: AdjustmentModel
}

/// The session's transaction ring: recorded undo / redo entries, the
/// transaction opened by `beginEdit` and not yet closed by a boundary, and
/// the monotonic id counter. Stored on `EditSession` as one value.
struct EditTransactionRing {
  var undoStack: [EditTransaction] = []
  var redoStack: [EditTransaction] = []
  var pending: PendingEdit?
  var nextID: UInt64 = 0
}
