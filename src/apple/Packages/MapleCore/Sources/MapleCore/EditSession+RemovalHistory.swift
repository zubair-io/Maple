// Durable removal authoring/history (#3984). A preview snapshot cannot change
// accepted pixels: companions and the source-bound XMP CAS must succeed first.
import Foundation

extension EditSession {
  /// Keep one reviewed proposal. The revision catches edit → undo while native
  /// inference runs, even when the current model equals its original snapshot.
  /// Once started, the session owns the commit; leaving the editor joins it.
  public func acceptRemoval(
    _ proposal: NativeRemovalProposal, snapshot: RemovalAuthoringSnapshot
  ) async throws {
    try await acceptRemovals([proposal], snapshot: snapshot)
  }

  /// Publish an ordered, reviewed group as one XMP commit and history entry.
  /// Intermediate assets may survive a failed publication, but no prefix of
  /// this group becomes visible in the sidecar or editor model.
  public func acceptRemovals(
    _ proposals: [NativeRemovalProposal], snapshot: RemovalAuthoringSnapshot
  ) async throws {
    try Task.checkCancellation()
    guard !proposals.isEmpty else { throw RemovalError.invalid("No removal proposals to keep") }
    let expectedModel = snapshot.model
    guard model == expectedModel, editRevision == snapshot.editRevision else {
      throw RemovalError.saveConflict
    }
    let task = try confirmedRemovalTask(
      transition: .new(
        .repair, proposals.count == 1 ? "Remove object" : "Remove \(proposals.count) objects"),
      sidecarRevision: snapshot.sidecarRevision
    ) { raw in
      let store = LocalRemovalAssetStore(rawURL: raw)
      var records = expectedModel.inpaintRemovals?.json ?? "[]"
      for proposal in proposals {
        records = try await store.publish(
          request: proposal.request, prior: records, mask: proposal.mask, patch: proposal.patch)
      }
      var accepted = expectedModel
      accepted.inpaintRemovals = try RemovalRecords(json: records)
      return accepted
    }
    try await task.value
  }

  /// Discrete whole-model reset. Scalar-only callers retain synchronous
  /// history; a reset that changes accepted pixels uses the same CAS as Keep.
  func commitModelSnapshot(
    _ target: AdjustmentModel, kind: EditTransaction.Kind, description: String
  ) {
    guard !isSavingRemoval, model != target else { return }
    if target.inpaintRemovals != model.inpaintRemovals {
      startRemovalHistory(target: target, transition: .new(kind, description))
    } else {
      beginEdit(kind: kind, description: description)
      model = target
      endEdit()
    }
  }

  /// A binding cannot bypass confirmed persistence or mutate the snapshot
  /// while its asynchronous commit is in flight. Chrome observes the busy
  /// flag; this guard also protects late analysis and keyboard callbacks.
  func permitsModelChange(from previous: AdjustmentModel) -> Bool {
    if isApplyingRemovalCommit { return true }
    guard !isSavingRemoval else { return false }
    guard model.inpaintRemovals == previous.inpaintRemovals else {
      sidecarError = RemovalError.invalid("Accepted removals require a confirmed save")
      return false
    }
    return true
  }

  enum RemovalHistoryTransition {
    case new(EditTransaction.Kind, String)
    case undo(EditTransaction)
    case redo(EditTransaction)
  }

  func startRemovalHistory(target: AdjustmentModel, transition: RemovalHistoryTransition) {
    do {
      _ = try confirmedRemovalTask(transition: transition) { _ in target }
    } catch {
      sidecarError = error
    }
  }

  private func confirmedRemovalTask(
    transition: RemovalHistoryTransition, sidecarRevision: RemovalSidecarRevision? = nil,
    prepare: @escaping @MainActor (URL) async throws -> AdjustmentModel
  ) throws -> Task<Void, Error> {
    guard !isSavingRemoval else { throw RemovalError.invalid("A removal save is already running") }
    guard let raw = asset.primaryURL, let store = sidecarStore as? XMPSidecarStore else {
      throw RemovalError.invalid("Removal authoring currently requires a local photo folder")
    }
    endEdit()
    let before = model
    let previous = sidecarUpdateTask
    isSavingRemoval = true
    let task = Task {
      var committed = false
      defer {
        isSavingRemoval = false
        // Culling can change during the cold save. Persist its latest value
        // with the confirmed model, never an old scalar snapshot after CAS.
        // A rejected CAS leaves external XML untouched. Queuing our stale
        // scalar model here would immediately overwrite the conflicting edit.
        if committed { scheduleSidecarUpdate(model: model, culling: culling) }
      }
      let scope = asset.scopeParentURL ?? raw
      let accessing = scope.startAccessingSecurityScopedResource()
      defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
      do {
        await previous?.value
        await store.flush()
        var target = try await prepare(raw)
        if target.inpaintRemovals?.isEmpty == true { target.inpaintRemovals = nil }
        try await store.writeRemovalConfirmed(
          records: target.inpaintRemovals?.json ?? "[]",
          expectedRecords: before.inpaintRemovals?.json ?? "[]", model: target, culling: culling,
          expectedSidecarRevision: sidecarRevision)
        // The write is durable now. Adopt it even if the initiating UI went
        // away; reporting cancellation here would leave disk and history split.
        isApplyingRemovalCommit = true
        model = target
        isApplyingRemovalCommit = false
        finishRemovalHistory(transition, before: before, after: target)
        sidecarError = nil
        committed = true
      } catch {
        sidecarError = error
        throw error
      }
    }
    removalCommitTask = task
    return task
  }

  private func finishRemovalHistory(
    _ transition: RemovalHistoryTransition, before: AdjustmentModel, after: AdjustmentModel
  ) {
    switch transition {
    case .new(let kind, let description):
      transactions.nextID &+= 1
      guard
        let tx = EditTransaction.make(
          id: transactions.nextID, kind: kind, description: description, before: before,
          after: after)
      else { return }
      transactions.redoStack.removeAll()
      record(tx)
      announcer.announce(description)
    case .undo(let tx):
      transactions.nextID &+= 1
      transactions.undoStack.removeLast()
      transactions.redoStack.append(tx)
      trim(&transactions.redoStack)
      lastCommittedTransaction = tx
      announcer.announce("Undo \(tx.description)")
    case .redo(let tx):
      transactions.nextID &+= 1
      transactions.redoStack.removeLast()
      transactions.undoStack.append(tx)
      trim(&transactions.undoStack)
      lastCommittedTransaction = tx
      announcer.announce("Redo \(tx.description)")
    }
  }
}
