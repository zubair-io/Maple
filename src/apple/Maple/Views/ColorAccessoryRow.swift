// Shared Color-section controls: profile, Black & White, white-balance
// sampling and provenance. The same controls remain reachable at every width.

import MapleCore
import SwiftUI

struct ColorAccessoryRow: View {
  @Bindable var state: EditorState
  var compactStyle = false

  /// Hand-built binding: `EditorState.session` is a `let` reference, so a
  /// `$state.session.model.profile` key-path projection won't form
  /// (the path segment isn't settable). The `EditSession` object itself
  /// is mutable through that constant reference, so read/write directly.
  private var profileBinding: Binding<Profile> {
    Binding(
      get: { state.session.model.profile },
      set: { state.session.model.profile = $0 }
    )
  }

  /// Black & white mix toggle (#276). Routes through
  /// `EditorState.setBlackWhite(_:)` rather than writing
  /// `session.model.blackWhite` directly — that method commits an undo
  /// snapshot and re-arms off `.hsl` if it was the armed tool (`.hsl`
  /// disappears from the Color pill row the moment B&W engages).
  private var blackWhiteBinding: Binding<Bool> {
    Binding(
      get: { state.session.model.blackWhite == .on },
      set: { state.setBlackWhite($0 ? .on : .off) }
    )
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if compactStyle {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Text("Profile")
              .font(.caption.weight(.medium))
              .foregroundStyle(MapleTokens.textMuted)
            Spacer(minLength: 4)
            if state.armedTool == .bwMix {
              Text("B&W")
                .font(.caption)
                .foregroundStyle(MapleTokens.textMuted)
                .accessibilityHidden(true)
              blackWhiteToggle.labelsHidden().toggleStyle(.switch).scaleEffect(0.85).fixedSize()
            }
            ProfilePicker(
              selection: profileBinding,
              autoFitStatus: state.session.autoFitStatus,
              showsStatus: false
            )
          }
          Text(state.session.autoFitStatus.description(profile: state.session.model.profile))
            .font(.caption2)
            .foregroundStyle(MapleTokens.textMuted)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .accessibilityLabel("Profile status")
            .accessibilityValue(
              state.session.autoFitStatus.description(profile: state.session.model.profile)
            )
            .accessibilityIdentifier("profile-auto-fit-status")
        }
      } else {
        profilePicker
        blackWhiteToggle.toggleStyle(.button).frame(minHeight: 44)
      }
      WhiteBalanceControls(state: state)
    }
    .padding(.horizontal, compactStyle ? 16 : 14)
    .padding(.vertical, compactStyle ? 6 : 8)
    .frame(maxWidth: .infinity)
    .background(MapleTokens.bg)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-color-accessory")
  }

  private var profilePicker: some View {
    HStack(alignment: .top, spacing: 6) {
      Text("Profile")
        .font(.caption)
        .foregroundStyle(MapleTokens.textMuted)
      ProfilePicker(selection: profileBinding, autoFitStatus: state.session.autoFitStatus)
    }
  }

  private var blackWhiteToggle: some View {
    Toggle(isOn: blackWhiteBinding) { Text("Black & White").font(.caption) }
      .accessibilityValue(state.session.model.blackWhite == .on ? "On" : "Off")
      .accessibilityIdentifier("editor-bw-toggle")
      .accessibilityLabel("Convert to black and white")
  }

}
