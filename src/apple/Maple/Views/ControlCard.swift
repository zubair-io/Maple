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
        VStack(spacing: 10) {
            // Group selector — accent-red pills at the TOP of the card.
            GroupChipsRow(state: state)
                .padding(.horizontal, 14)
                .padding(.top, 12)

            // Crop toolbar replaces the sliders while Crop is armed.
            if state.armedTool == .crop {
                CropToolbar(state: state)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
            } else {
                // Sub-param chip row for multi-param tools
                let subs = state.armedSubParams
                if subs.count > 1 {
                    SubParamRow(state: state)
                        .padding(.horizontal, 14)
                }
                // Color-group profile + as-shot row
                if state.armedGroup == .color {
                    ColorAccessoryRow(state: state)
                        .transition(.opacity)
                        .padding(.horizontal, 14)
                }
                // Living-slider grid for all tools in the active group
                LivingSliderGrid(state: state)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 14)
            }
        }
        .background(
            ProTokens.bg.opacity(ProGlass.opacity),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .padding(.horizontal, 12)
        .padding(.bottom, 12)
        .accessibilityIdentifier("editor-control-card")
    }
}

// MARK: - GroupChipsRow

/// Group selector rendered as accent-red rounded pills (active = accent fill
/// + accent border + accent label), left-aligned at the top of the control
/// card.  Mirrors the web `.group-chip` treatment; replaces the underline
/// `GroupTabsView` segmented row used by the old vertical editor.
private struct GroupChipsRow: View {
    @Bindable var state: EditorState

    var body: some View {
        HStack(spacing: 6) {
            ForEach(ToolGroup.allCases, id: \.self) { group in
                chip(group)
            }
            Spacer(minLength: 0)
        }
    }

    private func chip(_ group: ToolGroup) -> some View {
        let selected = state.armedGroup == group
        return Button {
            withAnimation(MapleTokens.Motion.groupSwap) { state.arm(group: group) }
        } label: {
            Text(group.displayName)
                .font(.system(size: 12, weight: selected ? .semibold : .regular))
                .foregroundStyle(selected ? ProTokens.accent : ProTokens.textMuted)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .background(Capsule().fill(selected ? ProTokens.accent(0x28) : Color.clear))
                .overlay(Capsule().stroke(selected ? ProTokens.accent : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("editor-group-\(group.rawValue)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
