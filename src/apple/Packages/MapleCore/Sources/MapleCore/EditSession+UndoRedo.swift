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
    if !transactions.undoStack.isEmpty { return true }
    guard let pending = transactions.pending else { return false }
    return pending.before != model
  }

  public var canRedo: Bool { !transactions.redoStack.isEmpty }

  /// Open a transaction before a user gesture or discrete edit. Closes
  /// any transaction still open (recording it if it changed anything) so
  /// two consecutive gestures never merge. Back-compatible default kind
  /// for the app's per-slider `commit()` sites.
  public func beginEdit(
    kind: EditTransaction.Kind = .adjustment, description: String = "Adjustment"
  ) {
    endEdit()
    transactions.nextID &+= 1
    transactions.pending = PendingEdit(
      id: transactions.nextID, kind: kind, description: description, before: model)
    transactions.redoStack.removeAll()
  }

  /// Close the open transaction. A no-op transaction (model unchanged)
  /// records nothing; anything else becomes exactly one undo entry.
  public func endEdit() {
    guard let pending = transactions.pending else { return }
    transactions.pending = nil
    guard
      let tx = EditTransaction.make(
        id: pending.id, kind: pending.kind, description: pending.description,
        before: pending.before, after: model)
    else { return }
    record(tx)
    // The transaction IS what the sidecar persists: hand `after` to the
    // store explicitly (it coalesces with the per-tick writes).
    scheduleSidecarUpdate(model: tx.after, culling: culling)
    announcer.announce(tx.description)
  }

  /// Abandon the open transaction without recording it. The model keeps
  /// whatever the preview ticks wrote (matches the web `cancelGesture`).
  public func cancelEdit() {
    transactions.pending = nil
  }

  public func undo() {
    endEdit()
    guard let tx = transactions.undoStack.popLast() else { return }
    transactions.redoStack.append(tx)
    trim(&transactions.redoStack)
    model = tx.before
    lastCommittedTransaction = tx
    announcer.announce("Undo \(tx.description)")
  }

  public func redo() {
    endEdit()
    guard let tx = transactions.redoStack.popLast() else { return }
    transactions.undoStack.append(tx)
    trim(&transactions.undoStack)
    model = tx.after
    lastCommittedTransaction = tx
    announcer.announce("Redo \(tx.description)")
  }

  public func resetToOriginal() {
    beginEdit(kind: .reset, description: "Reset to original")
    model = originalModel
    endEdit()
  }

  /// The recorded transactions, oldest first. Test / diagnostics seam.
  public var undoHistory: [EditTransaction] { transactions.undoStack }

  private func record(_ tx: EditTransaction) {
    transactions.undoStack.append(tx)
    trim(&transactions.undoStack)
    lastCommittedTransaction = tx
  }

  private func trim(_ stack: inout [EditTransaction]) {
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
