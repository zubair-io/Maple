import MapleCore
import MapleUI
import SwiftUI

/// Shared status in the desktop inspector and compact phone controls.
struct EditorSidecarStatus: View {
  let session: EditSession

  var body: some View {
    if session.isSavingRemoval {
      ProgressView("Saving removal…")
        .font(.caption)
        .padding(12)
        .accessibilityIdentifier("editor-saving-removal")
    }
    if let error = session.sidecarError {
      Text(error.localizedDescription)
        .font(.caption)
        .foregroundStyle(ProTokens.textMuted)
        .padding(12)
        .accessibilityIdentifier("editor-sidecar-save-error")
    }
  }
}
