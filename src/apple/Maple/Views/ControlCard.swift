// ControlCard.swift — Pro Editor Canvas-first (A2, #1555).
//
// Frosted-glass bottom card for the canvas-first editor: the living-slider
// grid for the active group (or the crop toolbar while Crop is armed), the
// sub-param chip row + color accessory when applicable, and the group tabs
// underneath.  Replaces the old bottom VStack (DragBar + ToolPillRow +
// GroupTabsView) from the vertical editor.

import SwiftUI
import MapleCore

struct ControlCard: View {
    @Bindable var state: EditorState
    var onPresetsTap: () -> Void = {}

    var body: some View {
        VStack(spacing: 0) {
            // Crop toolbar replaces sliders while Crop is armed
            if state.armedTool == .crop {
                CropToolbar(state: state)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 8)
            } else {
                // Sub-param chip row for multi-param tools
                let subs = state.armedSubParams
                if subs.count > 1 {
                    SubParamRow(state: state)
                        .padding(.vertical, 4)
                }
                // Color-group profile + as-shot row
                if state.armedGroup == .color {
                    ColorAccessoryRow(state: state)
                        .transition(.opacity)
                }
                // Living-slider grid for all tools in the active group
                LivingSliderGrid(state: state)
            }

            Divider()
                .background(ProTokens.border)

            GroupTabsView(state: state)
                .padding(.horizontal, 4)
        }
        .background(
            ProTokens.bg.opacity(ProGlass.opacity),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .accessibilityIdentifier("editor-control-card")
    }
}
