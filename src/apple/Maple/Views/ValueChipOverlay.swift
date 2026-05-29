// ValueChipOverlay.swift — responsive-program S5a (#625).
//
// Pill that floats top-center, 14pt above the canvas. Sticky-glass
// background (`rgba(15,13,11,0.6)` + 6pt blur). Contents (per spec §2):
//     LIGHT │ EXPOSURE  +0.25 EV
//   group   │ tool       signed value, tabular nums
// Always rendered — even at value 0.
//
// Display formatting per ToolValueMapping rules (EV for exposure, K for
// temp, integer otherwise).
//
// Spec: docs/design/responsive-program/s5-editor.md §2.

import SwiftUI
import MapleCore

struct ValueChipOverlay: View {
    @Bindable var state: EditorState

    private var formattedValue: String {
        let v = state.armedDisplayValue
        switch state.armedTool {
        case .exposure:
            return String(format: "%+0.2f EV", v)
        case .temp:
            return "\(Int(v.rounded())) K"
        default:
            return String(format: "%+d", Int(v.rounded()))
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(state.armedGroup.displayName.uppercased())
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(MapleTokens.textMuted)
            Rectangle()
                .fill(MapleTokens.textMuted.opacity(0.4))
                .frame(width: 1, height: 10)
            Text(state.armedTool.displayName.uppercased())
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(MapleTokens.textMuted)
            Text(formattedValue)
                .font(.system(size: 11, weight: .regular, design: .monospaced))
                .monospacedDigit()
                .foregroundStyle(MapleTokens.primary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            Color.black.opacity(0.6),
            in: Capsule()
        )
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("editor-value-chip")
    }
}
