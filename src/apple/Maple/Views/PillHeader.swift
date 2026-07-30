// PillHeader.swift — Pro Editor Canvas-first (A2, #1555).
//
// Frosted-glass pill at the top of the canvas.  Contains, left → right:
// back chevron, filename, live RGB histogram chip, before/after toggle
// (only while the session is dirty), undo (tap) / redo (long-press), info,
// share, zoom-percent readout, GPU/CPU render-path indicator.
//
// Replaces the full-width `EditorHeader` treatment from the old vertical
// editor.  The Info button plumbs the editor's `onInfo` closure (the
// iPhone Info sheet via EditorDestination, the desktop/iPad inspector
// reveal via EditorSessionHost) — without it the info affordance would be
// unreachable in the canvas-first shell.
//
// On compact width the trailing controls scroll horizontally so the pill
// always fits the screen and the back chevron + filename stay pinned and
// visible (`FloatingImageHeader`).

import SwiftUI
import MapleCore

struct PillHeader: View {
    @Bindable var state: EditorState
    let onBack: () -> Void
    let onShare: () -> Void
    let onInfo: () -> Void
    let showBeforeAfter: Bool

    var body: some View {
        FloatingImageHeader(
            displayName: state.session.asset.displayName,
            identifierPrefix: "editor",
            onBack: onBack
        ) {
            // Live RGB histogram chip (#1583) — 70×30, between the filename and
            // the before/after toggle, per the canvas-first design pill. Shares
            // `MiniHistogram` with the 56pt inspector block, so the curves and
            // the (debounced, off-render-path) data loading cannot drift; only
            // the chrome below is editor-specific.
            MiniHistogram(session: state.session)
                .frame(width: 70, height: 30)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .background(ProTokens.panel, in: RoundedRectangle(cornerRadius: 6))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(ProTokens.border, lineWidth: 0.5)
                )
                .allowsHitTesting(false)
                .accessibilityIdentifier("editor-pill-histogram")

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
                        .frame(width: 30, height: 30)
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
                    .frame(width: 30, height: 30)
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
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Info")
            .accessibilityIdentifier("editor-info")

            // Share / export
            Button(action: onShare) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(ProTokens.text)
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Share")
            .accessibilityIdentifier("editor-share")

            // Divider between action buttons and status indicators
            Rectangle()
                .fill(ProTokens.border)
                .frame(width: 1, height: 18)

            // Zoom percent readout — integer-rounded, same value the bottom-
            // leading zoom badge shows. Read from `effectivePixelScale` on
            // the zoom controller, formatted via FullImageViewVM.
            Text(FullImageViewVM.zoomPercentLabel(for: state.zoom.effectivePixelScale))
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(ProTokens.textMuted)
                .monospacedDigit()
                .frame(minWidth: 36, alignment: .trailing)
                .allowsHitTesting(false)
                .accessibilityLabel(
                    FullImageViewVM.zoomAccessibilityLabel(for: state.zoom.effectivePixelScale)
                )
                .accessibilityIdentifier("editor-pill-zoom")

            // GPU / CPU render-path indicator — mirrors the removed bottom-
            // trailing badge in EditorView.canvasLayer, same pill style.
            Text(state.session.gpuFramePresented ? "GPU" : "CPU")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(ProTokens.textDim)
                .allowsHitTesting(false)
                .accessibilityIdentifier("editor-pill-render-path")
        }
        .accessibilityIdentifier("editor-pill-header")
    }
}
