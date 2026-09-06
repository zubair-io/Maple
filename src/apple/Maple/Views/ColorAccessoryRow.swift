// ColorAccessoryRow.swift — Color-group accessory for the S5 editor (#875).
//
// Non-slider Color controls that lost their home when the Develop tab
// was removed (#875): the Profile picker (Auto / Neutral) and the As-Shot
// white-balance controls. These do not fit the "drag a value" tool-pill model, so
// they surface here as a thin contextual strip between the tool row and the
// group tabs — shown only while the Color group is armed.
//
// Profile binding matches the old DevelopTab: Profile binds straight to
// `session.model.profile` (no commit wrapper — the picker had none), and
// WhiteBalanceControls supplies As Shot, the eyedropper, and provenance.
//
// Lives in its own file so EditorView stays a thin composer (its own
// header note) and to mirror ProfilePicker's single-purpose file.

import MapleCore
import SwiftUI

struct ColorAccessoryRow: View {
  @Bindable var state: EditorState
  var compactStyle = false

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
      HStack(spacing: 12) {
        // Black & white mix (#276) — shown only while the B&W Mix tool
        // is armed; the eight gray-mixer sliders are meaningless (and
        // pipeline-forced inert) until this is on.
        if state.armedTool == .bwMix {
          Toggle(isOn: blackWhiteBinding) {
            Text("Black & White")
              .font(.system(size: 11, weight: .regular))
              .foregroundStyle(MapleTokens.textMuted)
          }
          .toggleStyle(.switch)
          .fixedSize()
          .accessibilityIdentifier("editor-bw-toggle")
          .accessibilityLabel("Convert to black and white")
        }

        HStack(spacing: 6) {
          Text("Profile")
            .font(.system(size: 11, weight: .regular))
            .foregroundStyle(MapleTokens.textMuted)
          ProfilePicker(selection: profileBinding)
            .frame(maxWidth: 160)
        }

      }
      WhiteBalanceControls(state: state)
    }
    .padding(.horizontal, compactStyle ? 24 : 12)
    .padding(.vertical, compactStyle ? 6 : 8)
    .frame(maxWidth: .infinity)
    .background(MapleTokens.bg)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-color-accessory")
  }
}
