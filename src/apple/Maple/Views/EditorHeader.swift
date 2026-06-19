// EditorHeader.swift — responsive-program S5a (#625).
//
// 44pt header. From left to right:
//   ‹  back
//   filename (SF Mono 12pt, ellipsized, center-justified)
//   ↺  undo  (tap=undo, long-press=redo, 32-entry ring on EditSession)
//   ⇪  share (stub for v0.1 — opens nothing)
//   ⓘ  info  (S6 / phone bottom-sheet)
//
// Spec: docs/design/responsive-program/s5-editor.md §2.

import SwiftUI
import MapleCore

struct EditorHeader: View {
    @Bindable var state: EditorState
    let onBack: () -> Void
    let onShare: () -> Void
    let onInfo: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(MapleTokens.textMain)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")
            .accessibilityIdentifier("editor-back")

            Spacer(minLength: 0)

            Text(state.session.asset.displayName)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(MapleTokens.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
                .accessibilityIdentifier("editor-filename")

            Spacer(minLength: 0)

            // AUTO — analyse the scene and set exposure + white balance, as
            // one undo entry (#1379). Disabled when there's no RAW file or an
            // analysis is already in flight; shows a spinner while running.
            Button(action: { Task { await state.applyAuto() } }) {
                if state.autoInProgress {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Auto")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(
                            state.session.asset.primaryURL != nil
                                ? MapleTokens.textMain : MapleTokens.textMuted
                        )
                }
            }
            .buttonStyle(.plain)
            .disabled(state.session.asset.primaryURL == nil || state.autoInProgress)
            .accessibilityLabel("Auto adjust")
            .accessibilityIdentifier("editor-auto")

            // RESET — factory defaults + As-Shot WB + Auto profile, crop
            // preserved, applied as one undo entry (#1372). Disabled on a
            // pristine image so it can't push a no-op undo snapshot.
            Button(action: { state.resetToFactoryDefaults() }) {
                Text("Reset")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(state.isDirty ? MapleTokens.textMain : MapleTokens.textMuted)
            }
            .buttonStyle(.plain)
            .disabled(!state.isDirty)
            .accessibilityLabel("Reset all adjustments")
            .accessibilityIdentifier("editor-reset")

            // Tap = undo, long-press = redo. Keep the button enabled
            // whenever either action is reachable so the long-press redo
            // path is still usable after the user undoes their only edit
            // (canUndo=false, canRedo=true). `state.undo()` is a no-op
            // when there's nothing to undo, so a stray tap in that state
            // is harmless.
            Button(action: { state.undo() }) {
                Image(systemName: "arrow.uturn.backward")
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle((state.canUndo || state.canRedo) ? MapleTokens.textMain : MapleTokens.textMuted)
            }
            .buttonStyle(.plain)
            .disabled(!state.canUndo && !state.canRedo)
            .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in state.redo() })
            .accessibilityLabel("Undo")
            .accessibilityIdentifier("editor-undo")

            Button(action: onShare) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(MapleTokens.textMain)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Share")
            .accessibilityIdentifier("editor-share")

            Button(action: onInfo) {
                Image(systemName: "info.circle")
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(MapleTokens.textMain)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Info")
            .accessibilityIdentifier("editor-info")
        }
        .padding(.horizontal, 16)
        .frame(height: 44)
        .background(MapleTokens.bg)
    }
}
