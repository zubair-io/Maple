// PillHeader.swift — Pro Editor Canvas-first (A2, #1555).
//
// Frosted-glass content-width pill at the top of the canvas.  Contains,
// left → right: back chevron, filename, live RGB histogram chip, AUTO,
// RESET, before/after toggle (only while the session is dirty), undo (tap)
// / redo (long-press), info, share, zoom-percent readout, GPU/CPU
// render-path indicator.
//
// Replaces the full-width `EditorHeader` treatment from the old vertical
// editor.  The Info button plumbs the editor's `onInfo` closure (the
// iPhone Info sheet via EditorDestination, the desktop/iPad inspector
// reveal via EditorSessionHost) — without it the info affordance would be
// unreachable in the canvas-first shell.
//
// AUTO / RESET (epic #1370, restored by #2244) live here for the same
// reason: `EditorHeader` hosted them until it was deleted with the
// canvas-first redesign, and the pill is the ONLY editor chrome mounted on
// every control variant and both size classes (`EditorView` LAYER 4).  The
// adjustments panel's own "Reset All" is variant- and iPad/Mac-only, so it
// cannot be the single home for RESET.

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

            // AUTO — analyses the scene and writes exposure + autoExposure
            // `.off` as one undo entry.  Disabled while the analysis runs
            // (`autoInProgress`); the accent tint is the in-flight cue.
            Button {
                Task { await state.applyAuto() }
            } label: {
                // `text`, not `textMuted`: the pill is `.ultraThinMaterial`,
                // so over a bright frame it goes near-white and the muted
                // token washes out to illegible. The icon buttons beside it
                // already use `text` for the same reason.
                Text("AUTO")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(0.6)
                    .foregroundStyle(state.autoInProgress ? ProTokens.accent : ProTokens.text)
                    .frame(height: 30)
                    .padding(.horizontal, 6)
            }
            .buttonStyle(.plain)
            .disabled(state.autoInProgress)
            .accessibilityLabel("Auto adjust")
            .accessibilityIdentifier("editor-auto")

            // RESET — every develop slider to its factory default, white
            // balance to camera As Shot, profile to Auto; crop/rotation kept.
            Button {
                state.resetToFactoryDefaults()
            } label: {
                Text("RESET")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(0.6)
                    .foregroundStyle(ProTokens.text)
                    .frame(height: 30)
                    .padding(.horizontal, 6)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Reset all adjustments")
            .accessibilityIdentifier("editor-reset-all")

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
