// Live adoption of a merged sidecar and the Undo/Redo ring rebuilt from the
// persisted history (#4983).
import Foundation

@MainActor
extension EditSession {
  func observeSidecarReconciliations() {
    sidecarReconciliationTask?.cancel()
    guard let store = sidecarStore as? any ReconcilingSidecarStoreProtocol else { return }
    sidecarReconciliationTask = Task { [weak self, store] in
      let stream = await store.reconciliations()
      for await document in stream {
        guard let self, !Task.isCancelled, self.sidecarStore === store else { return }
        await self.adopt(document, from: store)
      }
    }
  }

  /// Show the merge a store published. It is applied exactly like a confirmed workflow
  /// restore (no save is scheduled), so the next save never reverts it with the stale
  /// model. An editor that moved on since the save keeps its newer edits; its next save
  /// merges again against the document its model still represents.
  private func adopt(
    _ document: ReconciledSidecar, from store: any ReconcilingSidecarStoreProtocol
  ) async {
    await workflow.waitForIdle()
    await sidecarUpdateTask?.value
    guard isShowing(document, from: store) else { return }
    let started = (sidecarUpdateGeneration, workflow.generation, transactions.nextID)
    guard let restored = try? await workflow.restoredState(document.xml, session: self) else {
      return
    }
    guard isShowing(document, from: store),
      started == (sidecarUpdateGeneration, workflow.generation, transactions.nextID)
    else {
      workflow.releaseRasters(restored.0)
      return
    }
    applyConfirmedWorkflowState(restored)
    if workflow.documentXmp != nil { try? workflow.adoptDocument(document.xml) }
    await store.confirmAdoption(of: document.xml)
    await rebuildUndoRing(from: document.xml, since: started.2)
    announcer.announce("Sidecar changed outside Maple was merged")
  }

  private func isShowing(
    _ document: ReconciledSidecar, from store: any ReconcilingSidecarStoreProtocol
  ) -> Bool {
    !sidecarWritesDisabled && hasLoadedSidecar && sidecarStore === store
      && transactions.pending == nil && model == document.model && culling == document.culling
  }

  /// Rebuild the ring for a sidecar that already has history, once the editor has opened
  /// and the sidecar has loaded (whichever comes last calls this), unless an edit was made
  /// before the history could be read.
  func restoreUndoHistory() {
    guard hasLoadedSidecar, workflow.undoRestoreTask == nil,
      let writer = sidecarStore as? any WorkflowSidecarStoreProtocol,
      transactions.undoStack.isEmpty, transactions.redoStack.isEmpty
    else { return }
    let start = transactions.nextID
    workflow.undoRestoreTask = Task { [weak self] in
      guard let xml = try? await writer.readWorkflowXML(), let self else { return }
      await self.rebuildUndoRing(from: xml, since: start)
    }
  }

  /// Replace the ring with the one `xml`'s history folds to, unless an edit was
  /// recorded since `start` (its entries describe states the history lacks).
  func rebuildUndoRing(from xml: String, since start: UInt64) async {
    let variantId = workflow.selectedVariantId
    let cap = Self.undoStackCap
    let built = Task.detached(priority: .userInitiated) {
      try WorkflowUndoRing.make(xml: xml, variantId: variantId, cap: cap)
    }
    guard let ring = try? await built.value, !ring.undo.isEmpty || !ring.redo.isEmpty,
      transactions.nextID == start, transactions.pending == nil, hasLoadedSidecar,
      !sidecarWritesDisabled
    else { return }
    var next = transactions.nextID
    func transaction(_ step: WorkflowUndoStep) -> EditTransaction {
      next &+= 1
      return EditTransaction.workflow(
        id: next, description: step.description, before: step.before, after: step.after,
        checkpoint: step.checkpoint)
    }
    transactions.undoStack = ring.undo.map(transaction)
    transactions.redoStack = ring.redo.map(transaction).reversed()
    transactions.nextID = next
    lastCommittedTransaction = nil
  }
}
