// PillHeader.swift — Pro Editor Canvas-first (A2, #1555).
//
// Frosted-glass content-width pill at the top of the canvas.  Contains,
// left → right: back chevron, filename, before/after toggle (only while
// the session is dirty), undo (tap) / redo (long-press), info, share.
//
// Replaces the full-width `EditorHeader` treatment from the old vertical
// editor.  The Info button plumbs the editor's `onInfo` closure (the
// iPhone Info sheet via EditorDestination, the desktop/iPad inspector
// reveal via EditorSessionHost) — without it the info affordance would be
// unreachable in the canvas-first shell.

import SwiftUI
import MapleCore

struct PillHeader: View {
    @Bindable var state: EditorState
    let onBack: () -> Void
    let onShare: () -> Void
    let onInfo: () -> Void
    let showBeforeAfter: Bool

    var body: some View {
        HStack(spacing: 10) {
            // Back
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ProTokens.text)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")
            .accessibilityIdentifier("editor-back")

            // Filename
            Text(state.session.asset.displayName)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(ProTokens.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("editor-filename")

            // Before/after toggle — shown only when there are edits
            if showBeforeAfter {
                Button {
                    state.session.showingOriginal.toggle()
                } label: {
                    Image(systemName: state.session.showingOriginal
                          ? "circle.lefthalf.filled"
                          : "circle.righthalf.filled")
                        .font(.system(size: 15, weight: .regular))
                        .foregroundStyle(state.session.showingOriginal
                                         ? ProTokens.accent
                                         : ProTokens.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(state.session.showingOriginal ? "Show edited" : "Show original")
                .accessibilityIdentifier("editor-before-after")
            }

            // Undo (tap) / Redo (long-press)
            Button(action: { state.undo() }) {
                Image(systemName: "arrow.uturn.backward")
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle((state.canUndo || state.canRedo)
                                     ? ProTokens.text
                                     : ProTokens.textDim)
            }
            .buttonStyle(.plain)
            .disabled(!state.canUndo && !state.canRedo)
            .simultaneousGesture(
                LongPressGesture(minimumDuration: 0.5).onEnded { _ in state.redo() }
            )
            .accessibilityLabel("Undo")
            .accessibilityIdentifier("editor-undo")

            // Info — opens the iPhone Info sheet / reveals the desktop
            // inspector via the editor's `onInfo` closure.
            Button(action: onInfo) {
                Image(systemName: "info.circle")
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(ProTokens.text)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Info")
            .accessibilityIdentifier("editor-info")

            // Share / export
            Button(action: onShare) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(ProTokens.text)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Share")
            .accessibilityIdentifier("editor-share")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(ProTokens.bg.opacity(ProGlass.opacity), in: Capsule())
        .accessibilityIdentifier("editor-pill-header")
    }
}
