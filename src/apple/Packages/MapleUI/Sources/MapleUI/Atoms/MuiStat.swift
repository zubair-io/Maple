// MuiStat.swift — Maple UI Stat atom.
// Contract: docs/design/maple-ui/components/stat.md

import SwiftUI

public enum MuiStatSize: Sendable {
    case sm, lg
}

public enum MuiStatTrend: Sendable {
    case up, down, flat
}

/// A labeled numeric value — "128 Photos", "42 Selected" — with an optional
/// delta/trend indicator (stat.md §Purpose). Non-interactive.
public struct MuiStat: View {
    public let value: String
    public let label: String
    public let size: MuiStatSize
    public let delta: String?
    public let trend: MuiStatTrend?

    public init(
        value: String,
        label: String,
        size: MuiStatSize = .lg,
        delta: String? = nil,
        trend: MuiStatTrend? = nil
    ) {
        self.value = value
        self.label = label
        self.size = size
        self.delta = delta
        self.trend = trend
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(size == .lg ? .system(size: 28, weight: .bold) : .system(size: 17, weight: .semibold))
                .foregroundStyle(MuiTokens.textMain)
            HStack(spacing: MuiTokens.spacingXs) {
                Text(label)
                    .font(MuiTokens.TypeScale.font(.body))
                    .foregroundStyle(MuiTokens.textMuted)
                if let delta {
                    HStack(spacing: MuiTokens.spacingXs) {
                        if let trend {
                            Text(Self.trendGlyph(trend))
                                .accessibilityHidden(true)
                        }
                        Text(delta)
                    }
                    .font(MuiTokens.TypeScale.font(.chipLabel))
                    .foregroundStyle(Self.trendColor(trend))
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.accessibleLabel(value: value, label: label, delta: delta, trend: trend))
    }

    /// The accessible label a stat exposes to assistive technology —
    /// "128 Photos" or "1.2K Views, up +12". Public + static so this logic
    /// is unit-testable without rendering a view.
    public static func accessibleLabel(value: String, label: String, delta: String?, trend: MuiStatTrend?) -> String {
        var parts = ["\(value) \(label)"]
        if let delta {
            var deltaSegment = ""
            if let trend {
                deltaSegment = "\(trendWord(trend)) "
            }
            deltaSegment += delta
            parts.append(deltaSegment)
        }
        return parts.joined(separator: ", ")
    }

    // No dedicated trend-arrow icon exists in the Icon atom's registry
    // (only chevron-right/left/down, no directional up/down pair) — the
    // trend marker is a plain typographic glyph, not an Icon-atom instance
    // (stat.md §Tokens used).
    private static func trendGlyph(_ trend: MuiStatTrend) -> String {
        switch trend {
        case .up: return "▲"
        case .down: return "▼"
        case .flat: return "–"
        }
    }

    private static func trendWord(_ trend: MuiStatTrend) -> String {
        switch trend {
        case .up: return "up"
        case .down: return "down"
        case .flat: return "flat"
        }
    }

    private static func trendColor(_ trend: MuiStatTrend?) -> Color {
        switch trend {
        case .up: return MuiTokens.successText
        case .down: return MuiTokens.errorText
        case .flat, .none: return MuiTokens.textMuted
        }
    }
}

#Preview("MuiStat — Sizes") {
    HStack(spacing: 24) {
        MuiStat(value: "128", label: "Photos", size: .lg)
        MuiStat(value: "42", label: "Selected", size: .sm)
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiStat — Trend") {
    HStack(spacing: 24) {
        MuiStat(value: "1.2K", label: "Views", delta: "+12", trend: .up)
        MuiStat(value: "84", label: "Errors", delta: "-6", trend: .down)
        MuiStat(value: "50", label: "Idle", delta: "0", trend: .flat)
    }
    .padding()
    .background(MuiTokens.bg)
}
