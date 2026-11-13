import MapleCore
import SwiftUI

/// Removal-save progress in the desktop inspector and compact phone controls.
/// Save failures stay in the header's `EditorSidecarLoadNotice`.
struct EditorSidecarStatus: View {
  let session: EditSession

  var body: some View {
    if session.isSavingRemoval {
      ProgressView("Saving removal…")
        .font(.caption)
        .padding(12)
        .accessibilityIdentifier("editor-saving-removal")
    }
  }
}
