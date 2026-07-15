// ColorAccessoryRow.swift — Color-group accessory for the S5 editor (#875).
//
// Two non-slider Color controls that lost their home when the Develop tab
// was removed (#875): the Profile picker (Auto / Neutral) and the As-Shot
// white-balance reset. Neither fits the "drag a value" tool-pill model, so
// they surface here as a thin contextual strip between the tool row and the
// group tabs — shown only while the Color group is armed.
//
// Bindings match the old DevelopTab exactly: Profile binds straight to
// `session.model.profile` (no commit wrapper — the picker had none), and
// the As-Shot button reuses the original `beginEdit` + temperature/tint
// write. The button only appears when the asset actually carries an
// as-shot white balance, mirroring the old `if let cct…` guard.
//
// Lives in its own file so EditorView stays a thin composer (its own
// header note) and to mirror ProfilePicker's single-purpose file.

import SwiftUI
import MapleCore

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

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 6) {
                Text("Profile")
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(MapleTokens.textMuted)
                ProfilePicker(selection: profileBinding)
                    .frame(maxWidth: 160)
            }

            if let cct = session.asShotCCT, let tint = session.asShotTint {
                Spacer(minLength: 0)
                Button("As Shot") {
                    session.beginEdit()
                    session.model.temperature = cct
                    session.model.tint = tint
                }
                .font(.system(size: compactStyle ? 10 : 11, weight: compactStyle ? .medium : .regular))
                .buttonStyle(.borderless)
                .foregroundStyle(compactStyle ? MapleTokens.primary : MapleTokens.textMuted)
                .padding(.horizontal, compactStyle ? 10 : 0)
                .padding(.vertical, compactStyle ? 4 : 0)
                .background {
                    if compactStyle {
                        Capsule().fill(MapleTokens.primary.opacity(0.15))
                    }
                }
                .overlay {
                    if compactStyle {
                        Capsule().stroke(MapleTokens.primary, lineWidth: 0.5)
                    }
                }
                .accessibilityIdentifier("editor-as-shot-wb")
                .accessibilityLabel("Reset white balance to as-shot")
            }
        }
        .padding(.horizontal, compactStyle ? 24 : 12)
        .padding(.vertical, compactStyle ? 6 : 8)
        .frame(maxWidth: .infinity)
        .background(MapleTokens.bg)
        .accessibilityIdentifier("editor-color-accessory")
    }
}
