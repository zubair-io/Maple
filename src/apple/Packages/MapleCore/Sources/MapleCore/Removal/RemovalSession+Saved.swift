import Foundation

extension RemovalSession {
  public func setSavedRemoval(_ id: String, active: Bool?) async {
    guard phase == .ready, replacingRemovalID == nil, let snapshot else { return }
    let token = revision
    phase = .saving
    do {
      try await session.editSavedRemoval(id: id, active: active, snapshot: snapshot)
      guard current(token) else { return }
      phase = .ready
      await open()
    } catch { fail(error, token: token) }
  }

  public func replaceSavedRemoval(_ id: String) async {
    guard phase == .ready, replacingRemovalID == nil,
      let original = context, let snapshot,
      let entry = savedRemovals.first(where: { $0.id == id }), entry.editable,
      let maskDigest = entry.mask
    else { return }
    await setMode(.paint)
    clearSelection()
    let token = revision
    phase = .preparing
    do {
      let name = String(maskDigest.dropFirst(7)) + ".mask"
      guard let mask = original.assets[name] else { throw RemovalError.missingCompanion(name) }
      try RemovalBridge.verifyAsset(name: name, data: mask)
      let prefix = try await engine.replacementInput(id: id, original: original)
      guard current(token) else { return }
      guard session.model == snapshot.model, session.editRevision == snapshot.editRevision else {
        throw RemovalError.saveConflict
      }
      replacementOriginal = original
      replacingRemovalID = id
      replacementBase = mask
      selection = mask
      context = prefix
      phase = .ready
      message = "Refine this saved selection, then Remove and Keep to replace it."
    } catch { fail(error, token: token) }
  }

  public func cancelSavedReplacement() async {
    guard !busy, replacingRemovalID != nil else { return }
    await open()
  }
}
