import Foundation

extension EditSession {
  /// One undoable selected-group merge, acknowledged only after real sidecar
  /// I/O succeeds. Retry persists the same absolute patch without duplicating
  /// an unchanged undo entry; concurrent edits retain their usual autosave.
  public func applyAdjustmentTransfer(_ patch: PreparedAdjustmentTransfer) async throws {
    await loadSidecar()
    guard hasLoadedSidecar else {
      throw sidecarError ?? BatchAdjustmentError.invalidOperation
    }
    guard let store = sidecarStore else { throw BatchAdjustmentError.wrongLibrary }
    try patch.validate(current: model)
    let merged = patch.applying(to: model)
    if merged != model {
      endEdit()
      beginEdit(kind: .paste, description: "Paste settings")
      model = merged
      endEdit()
    }
    // endEdit enqueues the semantic checkpoint. A batch acknowledgement must
    // include that publication, including any pending retry retained by the store.
    await sidecarUpdateTask?.value
    try await store.writeConfirmed(model: model, culling: culling)
    sidecarError = nil
  }
}
