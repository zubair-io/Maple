import MapleCore
import SwiftUI

/// Compatibility composition for the legacy layouts retired by #3252.
/// Every input is implemented by the same LivingSlider as the stacked panel.
struct DragBar: View {
  @Bindable var state: EditorState

  var body: some View {
    LivingSliderRow(state: state, tool: state.armedTool)
      .disabled(!state.armedToolAcceptsValueEdits)
      .accessibilityIdentifier("editor-drag-bar")
  }
}
