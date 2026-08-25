// MuiActionButton.swift — Maple UI Action Button atom.
// Contract: docs/design/maple-ui/components/action-button.md

import SwiftUI

public enum MuiActionButtonOrientation: Sendable {
    case horizontal, stacked
}

public enum MuiActionButtonSize: Sendable {
    case sm, md
}

/// A compact icon+label pill for toolbars — the "select this tool"
/// affordance in a control rail (action-button.md §Purpose). Always
/// carries a glyph, unlike `MuiButton`'s optional icon slots.
public struct MuiActionButton: View {
    public let icon: String
    public let label: String
    public let size: MuiActionButtonSize
    public let orientation: MuiActionButtonOrientation
    public let selected: Bool
    public let disabled: Bool
    public let action: () -> Void

    @State private var isHovering = false
    @FocusState private var isFocused: Bool

    public init(
        icon: String,
        label: String,
        size: MuiActionButtonSize = .md,
        orientation: MuiActionButtonOrientation = .horizontal,
        selected: Bool = false,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) {
        self.icon = icon
        self.label = label
        self.size = size
        self.orientation = orientation
        self.selected = selected
        self.disabled = disabled
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            content
        }
        .buttonStyle(.plain)
        .focused($isFocused)
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
        .onHover { isHovering = $0 }
        .accessibilityLabel(label)
        // `selected` is a toggle/pressed state, not conveyed by background
        // color alone (action-button.md §Accessibility) — mirrors the
        // `[.isButton, .isSelected]` pattern used elsewhere in the package
        // (e.g. MuiTabs, MuiListRow) rather than a synthesized value string.
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    @ViewBuilder
    private var content: some View {
        let iconView = MuiIcon(name: icon, size: size == .sm ? .sm : .md, color: foregroundColor)
        let labelView = Text(label)
            .font(MuiTokens.TypeScale.font(.toolLabel))
            .foregroundStyle(foregroundColor)

        Group {
            if orientation == .horizontal {
                HStack(spacing: MuiTokens.spacingXs) { iconView; labelView }
            } else {
                VStack(spacing: MuiTokens.spacingXs) { iconView; labelView }
            }
        }
        .padding(.horizontal, orientation == .horizontal ? MuiTokens.spacingSm : MuiTokens.spacingXs)
        .padding(.vertical, MuiTokens.spacingXs)
        .background(backgroundColor, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous)
                .stroke(isFocused ? MuiTokens.primary.opacity(0.2) : .clear, lineWidth: 2)
        )
    }

    private var foregroundColor: Color {
        if selected { return MuiTokens.primary }
        if isHovering { return MuiTokens.textMain }
        return MuiTokens.textMuted
    }

    private var backgroundColor: Color {
        if selected { return MuiTokens.primaryDim }
        if isHovering { return MuiTokens.surfaceHover }
        return .clear
    }
}

#Preview("MuiActionButton — Orientation") {
    HStack(spacing: 12) {
        MuiActionButton(icon: "slider.horizontal.3", label: "Adjust", orientation: .horizontal) {}
        MuiActionButton(icon: "crop", label: "Crop", orientation: .stacked) {}
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiActionButton — States") {
    HStack(spacing: 12) {
        MuiActionButton(icon: "wand.and.stars", label: "Auto") {}
        MuiActionButton(icon: "wand.and.stars", label: "Auto", selected: true) {}
        MuiActionButton(icon: "wand.and.stars", label: "Auto", disabled: true) {}
    }
    .padding()
    .background(MuiTokens.bg)
}
