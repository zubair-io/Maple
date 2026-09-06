// Shared Color-section controls: profile, Black & White, white-balance
// sampling and provenance. The same controls remain reachable at every width.

import MapleCore
import SwiftUI

struct ColorAccessoryRow: View {
  @Bindable var state: EditorState

  private var session: EditSession { state.session }

  /// Hand-built binding: `EditorState.session` is a `let` reference, so a
  /// `$state.session.model.profile` key-path projection won't form
  /// (the path segment isn't settable). The `EditSession` object itself
  /// is mutable through that constant reference, so read/write directly.
  private var profileBinding: Binding<Profile> {
    Binding(
      get: { session.model.profile },
      set: { session.model.profile = $0 }
    )
  }

  /// Black & white mix toggle (#276). Routes through
  /// `EditorState.setBlackWhite(_:)` rather than writing
  /// `session.model.blackWhite` directly — that method commits an undo
  /// snapshot and re-arms off `.hsl` if it was the armed tool (`.hsl`
  /// disappears from the Color pill row the moment B&W engages).
  private var blackWhiteBinding: Binding<Bool> {
    Binding(
      get: { session.model.blackWhite == .on },
      set: { state.setBlackWhite($0 ? .on : .off) }
    )
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Text("Profile")
          .font(.caption)
          .foregroundStyle(MapleTokens.textMuted)
        ProfilePicker(selection: profileBinding)
          .frame(maxWidth: 160)
      }
      Toggle(isOn: blackWhiteBinding) { Text("Black & White").font(.caption) }
        .toggleStyle(.switch)
        .accessibilityIdentifier("editor-bw-toggle")
        .accessibilityLabel("Convert to black and white")
      WhiteBalanceControls(state: state)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity)
    .background(MapleTokens.bg)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-color-accessory")
  }
}
