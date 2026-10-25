// Shown while a failed sidecar read keeps the editor read-only (#4708), so the
// photographer knows why the controls are paused and can retry the read.
import MapleCore
import MapleUI
import SwiftUI

struct EditorSidecarLoadNotice: View {
  let session: EditSession

  var body: some View {
    if session.sidecarLoadFailed {
      HStack(spacing: MuiTokens.spacingSm) {
        MuiStatusText(state: .error, text: "Couldn't read saved edits — editing paused")
        MuiButton(label: "Retry", variant: .ghost, size: .sm) {
          Task { await session.loadSidecar() }
        }
        .accessibilityIdentifier("editor-sidecar-retry")
      }
      .padding(.horizontal, MuiTokens.spacingMd)
      .padding(.vertical, MuiTokens.spacingSm)
      .background(.ultraThinMaterial, in: Capsule())
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("editor-sidecar-load-failed")
    } else if let error = session.sidecarError {
      MuiStatusText(state: .error, text: error.localizedDescription)
        .padding(.horizontal, MuiTokens.spacingMd)
        .padding(.vertical, MuiTokens.spacingSm)
        .background(.ultraThinMaterial, in: Capsule())
        .accessibilityIdentifier("editor-sidecar-save-failed")
    }
  }
}
