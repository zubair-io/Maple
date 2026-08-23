// MuiStatusText.swift — Maple UI Status Text atom.
// Contract: docs/design/maple-ui/components/status-text.md

import SwiftUI

public enum MuiStatusTextState: Sendable {
    case idle, saving, saved, offline, error
}

/// A one-line persistence/sync status — "Saving…", "Saved", "Offline",
/// "Error" — paired with an icon (status-text.md §Purpose). `text`
/// overrides the state's default label (e.g. "Saved 2m ago") while keeping
/// the state's icon and color.
public struct MuiStatusText: View {
    public let state: MuiStatusTextState
    public let text: String?

    public init(state: MuiStatusTextState, text: String? = nil) {
        self.state = state
        self.text = text
    }

    public var body: some View {
        HStack(spacing: MuiTokens.spacingXs) {
            MuiIcon(name: Self.iconName(for: state), size: .xs, color: Self.color(for: state))
            Text(Self.displayText(state: state, text: text))
                .font(MuiTokens.TypeScale.font(.body))
                .foregroundStyle(Self.color(for: state))
        }
        // A state change (e.g. saving -> saved) is announced without the
        // user needing focus on the element (status-text.md
        // §Accessibility: role="status").
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.displayText(state: state, text: text))
        .accessibilityAddTraits(.updatesFrequently)
    }

    // No wifi/cloud/spinner-dedicated icon exists yet in the glyph set —
    // Saving reuses a "history" style glyph (reads as "in progress") and
    // Offline/Error are distinguished by weight rather than a dedicated
    // connectivity icon (status-text.md §Tokens used, flagged as a gap).
    public static func iconName(for state: MuiStatusTextState) -> String {
        switch state {
        case .idle: return "circle.fill"
        case .saving: return "clock.arrow.circlepath"
        case .saved: return "checkmark"
        case .offline: return "xmark"
        case .error: return "exclamationmark.circle.fill"
        }
    }

    public static func defaultText(for state: MuiStatusTextState) -> String {
        switch state {
        case .idle: return "Idle"
        case .saving: return "Saving…"
        case .saved: return "Saved"
        case .offline: return "Offline"
        case .error: return "Error"
        }
    }

    /// Public + static so the override-vs-default routing is unit-testable
    /// without rendering a view.
    public static func displayText(state: MuiStatusTextState, text: String?) -> String {
        text ?? defaultText(for: state)
    }

    public static func color(for state: MuiStatusTextState) -> Color {
        switch state {
        case .idle, .saving, .offline: return MuiTokens.textMuted
        case .saved: return MuiTokens.successText
        case .error: return MuiTokens.errorText
        }
    }
}

#Preview("MuiStatusText — States") {
    VStack(alignment: .leading, spacing: 8) {
        MuiStatusText(state: .idle)
        MuiStatusText(state: .saving)
        MuiStatusText(state: .saved)
        MuiStatusText(state: .offline)
        MuiStatusText(state: .error)
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiStatusText — Text override") {
    MuiStatusText(state: .saved, text: "Saved 2m ago")
        .padding()
        .background(MuiTokens.bg)
}
