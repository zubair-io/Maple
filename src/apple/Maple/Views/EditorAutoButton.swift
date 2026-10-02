import MapleCore
import SwiftUI

/// Shared editor chrome on Mac, iPad and iPhone (#3249).
struct EditorAutoButton: View {
  @Bindable var state: EditorState
  @State private var requested = false

  var body: some View {
    Button {
      requested = true
    } label: {
      ZStack {
        Image(systemName: "wand.and.rays")
          .font(.system(size: 22))
          .opacity(requested || state.autoInProgress ? 0 : 1)
        if requested || state.autoInProgress {
          ProgressView().controlSize(.small)
        }
      }
      .frame(width: 44, height: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!state.session.asset.isRaw || requested || state.autoInProgress)
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
