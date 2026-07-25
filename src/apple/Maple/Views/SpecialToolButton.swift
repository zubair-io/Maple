// SpecialToolButton.swift — the special-tools row's icon + label button,
// factored out of StackedAdjustmentsPanel (#640, which pushed that file past
// its 400-line soft budget).
//
// Crop and Presets are wired `Tool` cases and draw the shipped tool artwork;
// Mask and Heal have no `Tool` case yet and render as disabled SF Symbol
// placeholders.

import SwiftUI
import MapleCore

/// What a special-tool button draws: the shipped artwork for a wired `Tool`
/// case, or an SF Symbol for the placeholders whose `Tool` case doesn't exist
/// yet (Mask / Heal).
enum SpecialToolIcon {
    case tool(Tool)
    case symbol(String)
}

/// Small icon + label button used in the special-tools row at the top of
/// the adjustments panel.  Renders disabled (dimmed, non-interactive) when
/// `isEnabled` is false — used for tool cases not yet present in the enum.
struct SpecialToolButton: View {
    let icon: SpecialToolIcon
    let label: String
    let isSelected: Bool
    let isEnabled: Bool
    let action: () -> Void

    @ViewBuilder
    private var glyph: some View {
        switch icon {
        case .tool(let tool):
            ToolGlyph.icon(for: tool, size: 15)
        case .symbol(let name):
            Image(systemName: name)
                .font(.system(size: 13, weight: .regular))
        }
    }

    var body: some View {
        Button(action: isEnabled ? action : {}) {
            VStack(spacing: 3) {
                ZStack {
                    Circle()
                        .fill(isSelected
                              ? ProTokens.accent(0x28)
                              : ProTokens.panel)
                        .overlay(
                            Circle().stroke(
                                isSelected ? ProTokens.accent : ProTokens.border,
                                lineWidth: 0.5
                            )
                        )
                        .frame(width: 32, height: 32)

                    glyph
                        .foregroundStyle(
                            isEnabled
                                ? (isSelected ? ProTokens.accent : ProTokens.text)
                                : ProTokens.textDim
                        )
                }
                Text(label)
                    .font(.system(size: 9, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(
                        isEnabled
                            ? (isSelected ? ProTokens.accent : ProTokens.textMuted)
                            : ProTokens.textDim
                    )
                    .lineLimit(1)
            }
            .frame(width: 46)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityLabel(label)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        // Disabled placeholders (Mask/Heal) add no navigable value — keep them
        // out of the a11y tree, matching ToolDock/MobileControlBar (Copilot #1680).
        .accessibilityHidden(!isEnabled)
        .opacity(isEnabled ? 1 : 0.40)
    }
}
