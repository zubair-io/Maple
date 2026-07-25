// SubParamRow.swift — multi-param tool pills (#1108, spec §10.0).
//
// Compact chip selector shown directly above the drag bar while a
// multi-param tool (Noise, Sharpen) is armed. Tapping a chip arms that
// (tool, subParam) pair for the drag bar / value chip / fine mode /
// reset. Renders nothing for single-param tools — their layout is
// byte-for-byte the pre-#1108 editor column. Mirrors the web
// `SubParamRowComponent`.

import SwiftUI
import MapleCore
#if canImport(UIKit)
import UIKit
#endif

struct SubParamRow: View {
    @Bindable var state: EditorState

    var body: some View {
        // HSL declares 24 sub-params but owns its own two-axis selector
        // (`HSLSection`: 8 band swatches × 3 channel sliders, #274) — a
        // flat 24-chip row would neither fit the bar nor read as bands.
        let subs = state.armedTool == .hsl ? [] : state.armedSubParams
        if subs.count > 1 {
            HStack(spacing: 6) {
                ForEach(subs) { sub in
                    SubParamChip(state: state, sub: sub)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.top, 6)
            .background(MapleTokens.bg)
            .accessibilityIdentifier("editor-subparam-row")
        }
    }
}

private struct SubParamChip: View {
    @Bindable var state: EditorState
    let sub: ToolSubParam

    private var isArmed: Bool { state.armedSubParamId == sub.id }

    /// Per-chip modified dot — the sub-param's field is off its
    /// canonical default. Same tolerance as the tool pills' dot.
    private var isModified: Bool {
        abs(state.session.model[keyPath: sub.keyPath] - sub.defaultDisplayValue) > 1e-6
    }

    var body: some View {
        Button {
            guard !isArmed else { return }
            state.arm(subParamId: sub.id)
            emitSelectionHaptic()
        } label: {
            HStack(spacing: 5) {
                Text(sub.label)
                    .font(.system(size: 10, weight: isArmed ? .semibold : .medium))
                if isModified {
                    Circle()
                        .fill(MapleTokens.primary)
                        .frame(width: 4, height: 4)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 3)
            .foregroundStyle(isArmed ? MapleTokens.primary : MapleTokens.textMuted)
            .background(
                Capsule().fill(isArmed
                               ? MapleTokens.primary.opacity(0.15)
                               : MapleTokens.surfaceAlt)
            )
            .overlay(
                Capsule().stroke(isArmed ? MapleTokens.primary : MapleTokens.border,
                                 lineWidth: 0.5)
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(sub.label)
        .accessibilityAddTraits(isArmed ? .isSelected : [])
        .accessibilityIdentifier("editor-subparam-\(sub.id)")
    }

    private func emitSelectionHaptic() {
        #if canImport(UIKit) && !os(macOS)
        let gen = UISelectionFeedbackGenerator()
        gen.selectionChanged()
        #endif
    }
}

#if DEBUG
#Preview("SubParamRow — sharpen") {
    let state = EditorState(session: EditSession.preview())
    state.arm(tool: .sharpen)
    return VStack(spacing: 0) {
        SubParamRow(state: state)
        DragBar(state: state)
    }
    .background(MapleTokens.bg)
}
#endif
