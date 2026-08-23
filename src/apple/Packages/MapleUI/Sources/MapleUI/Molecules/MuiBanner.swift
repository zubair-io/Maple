// MuiBanner.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.3). Inline status strip, built from Icon + Text + Link + Button. Per
// the catalog's per-molecule composition rule (§8: "a Banner uses ghost
// Buttons, not primary"), the action and dismiss slots always render as
// ghost Buttons — there is no variant input for them.

import SwiftUI

public enum MuiBannerVariant: Sendable {
    case info, success, warning, error
}

public struct MuiBanner: View {
    public let variant: MuiBannerVariant
    public let message: String
    public let linkLabel: String?
    public let linkHref: String?
    public let actionLabel: String?
    public let dismissible: Bool
    public let actionPressed: (() -> Void)?
    public let dismissed: (() -> Void)?

    public init(
        variant: MuiBannerVariant = .info,
        message: String,
        linkLabel: String? = nil,
        linkHref: String? = nil,
        actionLabel: String? = nil,
        dismissible: Bool = false,
        actionPressed: (() -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.variant = variant
        self.message = message
        self.linkLabel = linkLabel
        self.linkHref = linkHref
        self.actionLabel = actionLabel
        self.dismissible = dismissible
        self.actionPressed = actionPressed
        self.dismissed = dismissed
    }

    public var body: some View {
        HStack(spacing: MuiTokens.spacingSm) {
            MuiIcon(name: Self.iconName(for: variant), size: .sm, color: Self.accentColor(for: variant))
            MuiText(message, variant: .body)
            Spacer(minLength: MuiTokens.spacingSm)

            if let linkLabel, let linkHref {
                MuiLink(title: linkLabel, href: linkHref)
            }
            if let actionLabel {
                MuiButton(label: actionLabel, variant: .ghost, size: .sm) { actionPressed?() }
            }
            if dismissible {
                MuiButton(label: "Dismiss", variant: .ghost, size: .sm, leadingIcon: "xmark", iconOnly: true) {
                    dismissed?()
                }
            }
        }
        .padding(.horizontal, MuiTokens.spacingMd)
        .padding(.vertical, MuiTokens.spacingSm)
        .background(Self.backgroundColor(for: variant), in: RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous)
                .stroke(Self.accentColor(for: variant).opacity(0.4), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }

    private static func iconName(for variant: MuiBannerVariant) -> String {
        switch variant {
        case .info: return "info.circle.fill"
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .error: return "xmark.circle.fill"
        }
    }

    private static func accentColor(for variant: MuiBannerVariant) -> Color {
        switch variant {
        case .info: return MuiTokens.textMuted
        case .success: return MuiTokens.successText
        case .warning: return MuiTokens.warn
        case .error: return MuiTokens.errorText
        }
    }

    private static func backgroundColor(for variant: MuiBannerVariant) -> Color {
        switch variant {
        case .info: return MuiTokens.surfaceAlt
        case .success: return MuiTokens.successBg
        case .warning: return MuiTokens.warn.opacity(0.15)
        case .error: return MuiTokens.errorBg
        }
    }
}

#Preview("MuiBanner — Variants") {
    VStack(spacing: 12) {
        MuiBanner(variant: .info, message: "Import will continue in the background.", linkLabel: "Learn more", linkHref: "maple://help/import")
        MuiBanner(variant: .success, message: "Export finished.", dismissible: true)
        MuiBanner(variant: .warning, message: "3 photos are missing their originals.", actionLabel: "Review")
        MuiBanner(variant: .error, message: "Batch export failed.", actionLabel: "Retry", dismissible: true)
    }
    .padding()
    .background(MuiTokens.bg)
}
