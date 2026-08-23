// MuiBadge.swift — Maple UI Badge atom.
// Contract: docs/design/maple-ui/components/badge.md

import SwiftUI

public enum MuiBadgeVariant: Sendable {
    case count, signal, rating
}

/// A small, filled status/count indicator. Informational, not interactive —
/// badges carry no hover/pressed/focused state (badge.md §States).
public struct MuiBadge: View {
    public let variant: MuiBadgeVariant
    public let value: String
    /// Accessible description when `value` alone isn't self-explanatory
    /// (e.g. "3 unread" rather than just "3") (badge.md §Props).
    public let label: String?

    public init(variant: MuiBadgeVariant = .count, value: String, label: String? = nil) {
        self.variant = variant
        self.value = value
        self.label = label
    }

    public var body: some View {
        Group {
            switch variant {
            case .count:
                pill(background: MuiTokens.primaryDim, foreground: MuiTokens.textMain)
            case .signal:
                pill(background: MuiTokens.warn.opacity(0.25), foreground: MuiTokens.textMain)
            case .rating:
                HStack(spacing: 2) {
                    MuiIcon(name: "star.fill", size: .xs, color: MuiTokens.star)
                    Text(value)
                        .font(MuiTokens.TypeScale.font(.chipLabel))
                        .foregroundStyle(MuiTokens.textMain)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.accessibleLabel(variant: variant, value: value, label: label))
    }

    @ViewBuilder
    private func pill(background: Color, foreground: Color) -> some View {
        Text(value)
            .font(MuiTokens.TypeScale.font(.chipLabel))
            .foregroundStyle(foreground)
            .padding(.horizontal, MuiTokens.spacingXs)
            .padding(.vertical, 2)
            .background(background, in: Capsule())
    }

    /// The accessible label a badge exposes to assistive technology — an
    /// explicit `label` override when supplied, otherwise `value` itself,
    /// except `rating` which is announced as "Rating N" so the numeric
    /// value reads correctly rather than just the glyph count (badge.md
    /// §Accessibility). Public + static so this logic is unit-testable
    /// without rendering a view.
    public static func accessibleLabel(variant: MuiBadgeVariant, value: String, label: String?) -> String {
        if let label { return label }
        return variant == .rating ? "Rating \(value)" : value
    }
}

#Preview("MuiBadge — Variants") {
    HStack(spacing: 12) {
        MuiBadge(variant: .count, value: "3")
        MuiBadge(variant: .signal, value: "Needs review")
        MuiBadge(variant: .rating, value: "4")
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiBadge — With accessible label") {
    MuiBadge(variant: .count, value: "3", label: "3 unread")
        .padding()
        .background(MuiTokens.bg)
}
