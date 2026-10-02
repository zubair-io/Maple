// Native filesystem transaction integration (#4046). Source-backed editors,
// variant switching and snapshot/history controls remain staged under #2437.
import Foundation

@MainActor
extension EditSession {
  func scheduleSemanticSidecarCommit(
    model: AdjustmentModel, culling: CullingState, action: String, label: String
  ) {
    // This stage owns local filesystem XMP only. Existing source-backed stores
    // retain their real ordinary save path until their #2437 integration lands.
    guard let local = sidecarStore as? XMPSidecarStore else {
      scheduleSidecarUpdate(model: model, culling: culling)
      return
    }
    let previous = sidecarUpdateTask
    sidecarUpdateTask = Task {
      await previous?.value
      do {
        try await local.commitSemantic(model: model, culling: culling, action: action, label: label)
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
