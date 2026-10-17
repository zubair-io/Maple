// Native filesystem, PhotoKit and API transaction integration (#4046/#4047/#4056). SMB editors,
// variant switching and snapshot/history controls remain staged under #2437.
import Foundation

@MainActor
extension EditSession {
  var sidecarStore: (any SidecarStoreProtocol)? {
    guard !sidecarWritesDisabled else { return nil }
    return workflow.selectedStore ?? primarySidecarStore
  }
  func observeSidecarErrors() {
    sidecarErrorTask?.cancel()
    guard let store = sidecarStore else { return }
    sidecarErrorTask = Task { [weak self, store] in
      let stream = await store.errors()
      for await error in stream {
        guard let self, !Task.isCancelled, self.sidecarStore === store else { return }
        self.hasUnconfirmedSidecarUpdate = true
        self.sidecarError = error
      }
    }
  }
  func scheduleSemanticSidecarCommit(
    model: AdjustmentModel, culling: CullingState, action: String, label: String
  ) {
    // Filesystem, PhotoKit and API expose the real semantic-commit capability.
    // SMB retains ordinary saves until its real share qualification lands (#2437).
    guard let semantic = sidecarStore as? any SemanticSidecarStoreProtocol else {
      scheduleSidecarUpdate(model: model, culling: culling)
      return
    }
    hasUnconfirmedSidecarUpdate = true
    let previous = sidecarUpdateTask
    sidecarUpdateTask = Task {
      await previous?.value
      guard !self.sidecarWritesDisabled, !Task.isCancelled else { return }
      do {
        try await semantic.commitSemantic(
          model: model, culling: culling, action: action, label: label)
        self.hasUnconfirmedSidecarUpdate = false
        self.sidecarError = nil
      } catch {
        self.hasUnconfirmedSidecarUpdate = true
        self.sidecarDirtyWhileDisabled = true
        self.sidecarError = error
      }
    }
  }

  func workflowAction(for kind: EditTransaction.Kind) -> String {
    switch kind {
    case .paste, .preset, .reset: return kind.rawValue
    case .adjustment, .auto, .crop, .mask, .repair, .variant: return "adjustment"
    }
  }
}
