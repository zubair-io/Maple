import MapleCore
import SwiftUI

/// The monochrome counterpart to HSLSection. Every generated mix band stays
/// reachable when the shared Color section's Black & White switch is on.
struct BlackWhiteMixSection: View {
  @Bindable var state: EditorState

  var body: some View {
    VStack(spacing: 10) {
      ForEach(Tool.bwMix.subParams) { sub in
        LivingSlider(
          label: sub.label,
          value: Binding(
            get: { state.session.model[keyPath: sub.keyPath] },
            set: { value in
              state.setBlackWhiteMixValue(value, bandID: sub.id)
            }),
          range: sub.range,
          isBipolar: true,
          defaultValue: sub.defaultDisplayValue,
          onCommit: { state.endGesture() }
        )
        .accessibilityIdentifier("editor-bw-mix-\(sub.id)")
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Black and white mix")
    .accessibilityIdentifier("editor-bw-mix")
  }
}
