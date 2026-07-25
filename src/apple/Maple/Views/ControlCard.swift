// ControlCard.swift — Pro Editor Canvas-first (A2, #1555).
//
// Frosted-glass bottom card for the canvas-first editor variant A (.compact):
// the living-slider grid for the active group (or the crop toolbar while Crop
// is armed), the sub-param chip row + color accessory when applicable, and the
// group selector.
//
// Layout branches on size class:
//   • Regular (macOS / iPad): the ToolDock already shows GROUP buttons on the
//     right, so GroupChipsRow is NOT shown here.  Instead, a one-line strip
//     with the active group name + reset-group button heads the card.
//   • Compact (iPhone): ToolDock is hidden; GroupChipsRow stays at the top of
//     the card as the sole group-switching affordance.

import SwiftUI
import MapleCore

struct ControlCard: View {
    @Bindable var state: EditorState
    var onPresetsTap: () -> Void = {}

    @Environment(\.horizontalSizeClass) private var hSizeClass

    private var isRegular: Bool { hSizeClass == .regular }

    var body: some View {
        VStack(spacing: 10) {
            // Header row: group title + reset on regular; group chips on compact.
            if isRegular {
                RegularCardHeader(state: state)
                    .padding(.horizontal, 14)
                    .padding(.top, 12)
            } else {
                GroupChipsRow(state: state)
                    .padding(.horizontal, 14)
                    .padding(.top, 12)
            }

            // Crop toolbar replaces the sliders while Crop is armed.
            if state.armedTool == .crop {
                CropToolbar(state: state)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
            } else if state.armedTool == .hsl {
                // 8-band HSL panel replaces the slider grid (#274).
                HSLSection(state: state)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 14)
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

// MARK: - RegularCardHeader

/// Shown on regular size class (macOS / iPad) instead of `GroupChipsRow` —
/// the dock already handles group switching, so the card header shows ONLY
/// the active group name and a reset-group affordance.
private struct RegularCardHeader: View {
    @Bindable var state: EditorState

    var body: some View {
        HStack {
            Text(state.armedGroup.displayName.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(ProTokens.text)
                .animation(.none, value: state.armedGroup)

            Spacer(minLength: 0)

            Button {
                resetActiveGroup()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.system(size: 10, weight: .regular))
                    Text("Reset")
                        .font(.system(size: 10, weight: .regular))
                }
                .foregroundStyle(ProTokens.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Reset \(state.armedGroup.displayName) adjustments")
            .accessibilityIdentifier("editor-card-reset-group")
        }
    }

    /// Resets all wired tools in the armed group to their canonical defaults.
    /// Commits ONCE up front so the whole group reset is a single undo boundary,
    /// then batch-applies each tool's default WITHOUT arming it — arming per
    /// tool would spawn extra crop-session transitions and undo entries.
    private func resetActiveGroup() {
        let tools = Tool.tools(in: state.armedGroup)
            .filter { $0.isWired && ToolValueMapping.displayRange(for: $0) != nil }
        guard !tools.isEmpty else { return }
        state.commit()
        for tool in tools {
            ToolValueMapping.apply(
                ToolValueMapping.defaultDisplayValue(for: tool),
                to: &state.session.model,
                tool: tool
            )
        }
    }
}

// MARK: - GroupChipsRow

/// Group selector rendered as accent-red rounded pills (active = accent fill
/// + accent border + accent label), left-aligned at the top of the control
/// card.  Shown on compact (iPhone) only — on regular the ToolDock handles
/// group switching and this row is suppressed (see ControlCard.body).
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
