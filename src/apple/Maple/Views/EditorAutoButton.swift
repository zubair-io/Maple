import MapleCore
import MapleUI
import SwiftUI

/// Shared editor chrome on Mac, iPad and iPhone (#3249).
struct EditorAutoButton: View {
  @Bindable var state: EditorState
  @State private var requested = false

  var body: some View {
    MuiButton(
      label: "AUTO",
      variant: .ghost,
      size: .sm,
      isLoading: requested || state.autoInProgress,
      disabled: !state.session.asset.isRaw || state.session.asset.primaryURL == nil
    ) {
      requested = true
    }
    .accessibilityLabel("Auto adjust")
    .accessibilityValue(requested || state.autoInProgress ? "Analysing" : "Ready")
    .accessibilityHint("Adjust exposure and tone while keeping white balance.")
    .accessibilityIdentifier("editor-auto")
    .help("Automatically adjust exposure and tone")
    .task(id: requested) {
      guard requested else { return }
      await state.applyAuto()
      requested = false
    }
  }
}
