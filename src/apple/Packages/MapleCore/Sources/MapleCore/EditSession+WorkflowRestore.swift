import Foundation

public struct WorkflowCheckpoint: Equatable, Sendable {
  public let before: String
  public let after: String
}

@MainActor
extension EditSession {
  func recordWorkflowRestore(
    before: String, after: String, restored: (AdjustmentModel, CullingState), label: String
  ) {
    transactions.nextID &+= 1
    let tx = EditTransaction.workflow(
      id: transactions.nextID, description: label, before: model, after: restored.0,
      checkpoint: WorkflowCheckpoint(before: before, after: after))
    transactions.pending = nil
    transactions.undoStack.append(tx)
    if transactions.undoStack.count > Self.undoStackCap {
      transactions.undoStack.removeFirst(transactions.undoStack.count - Self.undoStackCap)
    }
    transactions.redoStack.removeAll()
    applyConfirmedWorkflowState(restored)
    lastCommittedTransaction = tx
    announcer.announce(label)
  }

  func finishWorkflowReplay(
    transaction: EditTransaction, undo: Bool, restored: (AdjustmentModel, CullingState)
  ) {
    guard
      (undo ? transactions.undoStack.last?.id : transactions.redoStack.last?.id) == transaction.id
    else { return }
    if undo {
      transactions.undoStack.removeLast()
      transactions.redoStack.append(transaction)
      if transactions.redoStack.count > Self.undoStackCap {
        transactions.redoStack.removeFirst(transactions.redoStack.count - Self.undoStackCap)
      }
    } else {
      transactions.redoStack.removeLast()
      transactions.undoStack.append(transaction)
      if transactions.undoStack.count > Self.undoStackCap {
        transactions.undoStack.removeFirst(transactions.undoStack.count - Self.undoStackCap)
      }
    }
    applyConfirmedWorkflowState(restored)
    lastCommittedTransaction = transaction
    announcer.announce("\(undo ? "Undo" : "Redo") \(transaction.description)")
  }

  private func applyConfirmedWorkflowState(_ restored: (AdjustmentModel, CullingState)) {
    workflow.isApplying = true
    defer { workflow.isApplying = false }
    // `model.didSet` retains the normal render/cache invalidation. The XMP has
    // already been durably published; scheduling a model-only save would destroy
    // the exact foreign XML checkpoint we just restored.
    model = restored.0
    culling = restored.1
    hasLoadedSidecar = true
  }
}
