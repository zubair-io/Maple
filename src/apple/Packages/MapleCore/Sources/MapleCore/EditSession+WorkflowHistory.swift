// Native filesystem, PhotoKit and API transaction integration (#4046/#4047/#4056). SMB editors,
// variant switching and snapshot/history controls remain staged under #2437.
import Foundation

@MainActor
extension EditSession {
  func scheduleSemanticSidecarCommit(
    model: AdjustmentModel, culling: CullingState, action: String, label: String
  ) {
    // Filesystem, PhotoKit and API expose the real semantic-commit capability.
    // SMB retains ordinary saves until its real share qualification lands (#2437).
    guard let semantic = sidecarStore as? any SemanticSidecarStoreProtocol else {
      scheduleSidecarUpdate(model: model, culling: culling)
      return
    }
    let previous = sidecarUpdateTask
    sidecarUpdateTask = Task {
      await previous?.value
      do {
        try await semantic.commitSemantic(
          model: model, culling: culling, action: action, label: label)
        self.sidecarError = nil
      } catch {
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
