// MuiTimestamp.swift — Maple UI Timestamp atom.
// Contract: docs/design/maple-ui/components/timestamp.md

import SwiftUI

/// Timestamp formats (timestamp.md §Variants).
public enum MuiTimestampFormat: Sendable {
    case relative, short, long, timeOnly
}

/// A formatted date/time. Centralizes relative-time math and locale-aware
/// absolute formatting so every call site doesn't reimplement its own
/// "how old is this" arithmetic (timestamp.md §Purpose).
public struct MuiTimestamp: View {
    public let value: Date
    public let format: MuiTimestampFormat
    /// The reference "current time" for relative formatting. Defaults to
    /// the real clock; pass a fixed `Date` in tests for deterministic
    /// output instead of racing the wall clock (timestamp.md §Props).
    public let now: Date

    public init(value: Date, format: MuiTimestampFormat = .relative, now: Date = Date()) {
        self.value = value
        self.format = format
        self.now = now
    }

    public var body: some View {
        Text(Self.displayString(value: value, format: format, now: now))
            .font(MuiTokens.TypeScale.font(.body))
            .foregroundStyle(MuiTokens.textMuted)
            // Sighted-hover affordance only (macOS); not a substitute for
            // the accessibility label below (timestamp.md §Accessibility).
            .help(Self.absoluteString(value))
            .accessibilityLabel(Self.absoluteString(value))
    }

    // MARK: - Formatting (public + static for deterministic unit testing)

    /// The relative-time degrade ladder: "just now" (under a minute) →
    /// "Nm ago" → "Nh ago" → "Nd ago" (up to a six-day ceiling) → an
    /// absolute short date beyond that (timestamp.md §Variants).
    public static func relativeString(value: Date, now: Date) -> String {
        let delta = max(0, now.timeIntervalSince(value))
        if delta < 60 { return "just now" }
        if delta < 3600 { return "\(Int(delta / 60))m ago" }
        if delta < 86400 { return "\(Int(delta / 3600))h ago" }
        let days = Int(delta / 86400)
        if days <= 6 { return "\(days)d ago" }
        return shortDateFormatter.string(from: value)
    }

    public static func displayString(value: Date, format: MuiTimestampFormat, now: Date) -> String {
        switch format {
        case .relative: return relativeString(value: value, now: now)
        case .short: return shortDateFormatter.string(from: value)
        case .long: return longDateFormatter.string(from: value)
        case .timeOnly: return timeOnlyFormatter.string(from: value)
        }
    }

    /// Full absolute date + time — the tooltip / accessibility-label value,
    /// independent of which format is currently displayed.
    public static func absoluteString(_ value: Date) -> String {
        longDateFormatter.string(from: value)
    }

    private static let shortDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMM d, yyyy")
        return formatter
    }()

    private static let longDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMMM d, yyyy, h:mm a")
        return formatter
    }()

    private static let timeOnlyFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("h:mm a")
        return formatter
    }()
}

#Preview("MuiTimestamp — Relative ladder") {
    let now = Date()
    return VStack(alignment: .leading, spacing: 8) {
        MuiTimestamp(value: now.addingTimeInterval(-10), now: now)
        MuiTimestamp(value: now.addingTimeInterval(-5 * 60), now: now)
        MuiTimestamp(value: now.addingTimeInterval(-3 * 3600), now: now)
        MuiTimestamp(value: now.addingTimeInterval(-2 * 86400), now: now)
        MuiTimestamp(value: now.addingTimeInterval(-30 * 86400), now: now)
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiTimestamp — Formats") {
    let value = Date(timeIntervalSince1970: 1_787_000_000)
    let now = Date()
    return VStack(alignment: .leading, spacing: 8) {
        MuiTimestamp(value: value, format: .short, now: now)
        MuiTimestamp(value: value, format: .long, now: now)
        MuiTimestamp(value: value, format: .timeOnly, now: now)
    }
    .padding()
    .background(MuiTokens.bg)
}
