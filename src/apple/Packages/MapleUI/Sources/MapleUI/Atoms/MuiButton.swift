// MuiButton.swift — Maple UI Button atom.
// Contract: docs/design/maple-ui/components/button.md

import SwiftUI

public enum MuiButtonVariant: Sendable {
    case primary, secondary, ghost, destructive
}

public enum MuiButtonSize: Sendable {
    case sm, md, lg
}

/// The primary interactive control for committing an action (button.md
/// §Purpose) — the most-used atom in the system.
public struct MuiButton: View {
    public let label: String
    public let variant: MuiButtonVariant
    public let size: MuiButtonSize
    public let leadingIcon: String?
    public let trailingIcon: String?
    /// Hides the visible label (icon-only mode, catalog §1.1 "icon slots:
    /// ... icon-only") while `label` still supplies the accessible name —
    /// button.md §Accessibility forbids an icon-only button with none.
    public let iconOnly: Bool
    public let isLoading: Bool
    public let disabled: Bool
    public let action: () -> Void

    @State private var isHovering = false
    @FocusState private var isFocused: Bool

    public init(
        label: String,
        variant: MuiButtonVariant = .secondary,
        size: MuiButtonSize = .md,
        leadingIcon: String? = nil,
        trailingIcon: String? = nil,
        iconOnly: Bool = false,
        isLoading: Bool = false,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) {
        self.label = label
        self.variant = variant
        self.size = size
        self.leadingIcon = leadingIcon
        self.trailingIcon = trailingIcon
        self.iconOnly = iconOnly
        self.isLoading = isLoading
        self.disabled = disabled
        self.action = action
    }

    public var body: some View {
        Button {
            guard !disabled, !isLoading else { return }
            action()
        } label: {
            content
        }
        .buttonStyle(.plain)
        .focused($isFocused)
        .disabled(disabled || isLoading)
        .opacity(disabled ? 0.45 : 1)
        .onHover { isHovering = $0 }
        // Hover-lift: primary/destructive step up 2px over 200ms; no
        // tokenized hover/press duration exists yet (button.md §States) —
        // hardcoded consistently across platforms per that note.
        .offset(y: liftOffset)
        .animation(.easeInOut(duration: MuiTokens.hoverPressSeconds), value: isHovering)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder
    private var content: some View {
        HStack(spacing: MuiTokens.spacingXs) {
            if isLoading {
                ProgressView()
                    .controlSize(.small)
                    .tint(foregroundColor)
            } else {
                if let leadingIcon {
                    MuiIcon(name: leadingIcon, size: iconSize, color: foregroundColor)
                }
                if !iconOnly {
                    Text(label).font(.system(size: fontSize, weight: .semibold))
                }
                if let trailingIcon {
                    MuiIcon(name: trailingIcon, size: iconSize, color: foregroundColor)
                }
            }
        }
        .padding(.horizontal, horizontalPadding)
        .padding(.vertical, verticalPadding)
        .frame(minWidth: 44, minHeight: 44)
        .foregroundStyle(foregroundColor)
        .background {
            RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous)
                .fill(backgroundColor)
                .brightness(backgroundBrightness)
        }
        .overlay(
            RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous)
                .stroke(borderColor, lineWidth: variant == .secondary ? 1 : 0)
        )
        .overlay(
            RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous)
                .stroke(isFocused ? MuiTokens.primary.opacity(0.2) : .clear, lineWidth: 2)
                .padding(-2)
        )
    }

    private var liftOffset: CGFloat {
        guard !disabled, isHovering, variant == .primary || variant == .destructive else { return 0 }
        return -2
    }

    private var fillColor: Color {
        switch variant {
        case .primary: return MuiTokens.primary
        case .secondary: return MuiTokens.surface
        case .ghost: return .clear
        // No dedicated "destructive fill" token exists yet — flagged as a
        // follow-up in button.md §Variants; using error_bg/error_text
        // until that gap closes.
        case .destructive: return MuiTokens.errorBg
        }
    }

    private var backgroundColor: Color {
        switch variant {
        case .primary, .destructive: return fillColor
        case .secondary, .ghost: return isHovering ? MuiTokens.surfaceHover : fillColor
        }
    }

    private var backgroundBrightness: Double {
        (isHovering && (variant == .primary || variant == .destructive)) ? -0.08 : 0
    }

    private var foregroundColor: Color {
        switch variant {
        case .primary, .secondary, .ghost: return MuiTokens.textMain
        case .destructive: return MuiTokens.errorText
        }
    }

    private var borderColor: Color {
        variant == .secondary ? MuiTokens.border : .clear
    }

    private var iconSize: MuiIconSize {
        switch size {
        case .sm: return .xs
        case .md: return .sm
        case .lg: return .md
        }
    }

    private var fontSize: CGFloat {
        switch size {
        case .sm: return 13
        case .md: return 14
        case .lg: return 16
        }
    }

    private var horizontalPadding: CGFloat {
        switch size {
        case .sm: return MuiTokens.spacingSm
        case .md: return MuiTokens.spacingMd
        case .lg: return MuiTokens.spacingLg
        }
    }

    private var verticalPadding: CGFloat {
        switch size {
        case .sm: return MuiTokens.spacingXs
        case .md, .lg: return MuiTokens.spacingSm
        }
    }
}

#Preview("MuiButton — Variants") {
    VStack(spacing: 12) {
        MuiButton(label: "Primary", variant: .primary) {}
        MuiButton(label: "Secondary", variant: .secondary) {}
        MuiButton(label: "Ghost", variant: .ghost) {}
        MuiButton(label: "Destructive", variant: .destructive) {}
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiButton — Sizes") {
    HStack(spacing: 12) {
        MuiButton(label: "Small", variant: .primary, size: .sm) {}
        MuiButton(label: "Medium", variant: .primary, size: .md) {}
        MuiButton(label: "Large", variant: .primary, size: .lg) {}
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiButton — States") {
    VStack(spacing: 12) {
        MuiButton(label: "Disabled", variant: .primary, disabled: true) {}
        MuiButton(label: "Loading", variant: .primary, isLoading: true) {}
        MuiButton(label: "Add", variant: .secondary, leadingIcon: "plus") {}
        MuiButton(label: "Delete", variant: .destructive, leadingIcon: "trash", iconOnly: true) {}
    }
    .padding()
    .background(MuiTokens.bg)
}
