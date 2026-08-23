// MuiText.swift — Maple UI Text atom.
// Contract: docs/design/maple-ui/components/text.md

import SwiftUI

/// The full type scale (text.md §Variants), one case per named scale step.
public enum MuiTextVariant: Sendable {
    case sourceTitle
    case sheetTitle
    case rowLabel
    case body
    case toolLabel
    case chipLabel
    case eyebrow
    case valueChip
    case filename
}

/// Color roles (text.md §Props).
public enum MuiTextColor: Sendable {
    case main, muted, onAccent, success, warning, error
}

/// A styled text block — the single atom every label, caption, title, and
/// body copy routes through (text.md §Purpose).
///
/// Carries no semantic heading level of its own (text.md §Accessibility) —
/// callers applying `sourceTitle` for an `<h1>`-equivalent are responsible
/// for the platform's own structural role (e.g. `.accessibilityAddTraits(.isHeader)`).
public struct MuiText: View {
    public let content: String
    public let variant: MuiTextVariant
    public let color: MuiTextColor
    public let truncate: Bool
    public let lineClamp: Int?
    public let block: Bool

    public init(
        _ content: String,
        variant: MuiTextVariant = .body,
        color: MuiTextColor = .main,
        truncate: Bool = false,
        lineClamp: Int? = nil,
        block: Bool = false
    ) {
        self.content = content
        self.variant = variant
        self.color = color
        self.truncate = truncate
        self.lineClamp = lineClamp
        self.block = block
    }

    public var body: some View {
        Text(content)
            .font(MuiTokens.TypeScale.font(variant))
            .tracking(variant == .eyebrow ? 0.6 : 0)
            .textCase(variant == .eyebrow ? .uppercase : nil)
            .foregroundStyle(foregroundColor)
            .lineLimit(effectiveLineLimit)
            .truncationMode(.tail)
            .frame(maxWidth: block ? .infinity : nil, alignment: .leading)
    }

    private var effectiveLineLimit: Int? {
        if truncate { return 1 }
        if let lineClamp { return lineClamp }
        return nil
    }

    private var foregroundColor: Color {
        switch color {
        case .main: return MuiTokens.textMain
        case .muted: return MuiTokens.textMuted
        // No dedicated "on accent" token exists yet — text_main already
        // reads correctly over the primary/error accent fills used
        // elsewhere (text.md §Tokens used, mirroring button.md's primary
        // fill label color).
        case .onAccent: return MuiTokens.textMain
        case .success: return MuiTokens.successText
        case .warning: return MuiTokens.warn
        case .error: return MuiTokens.errorText
        }
    }
}

#Preview("MuiText — Type scale") {
    VStack(alignment: .leading, spacing: 10) {
        MuiText("Source Title", variant: .sourceTitle)
        MuiText("Sheet Title", variant: .sheetTitle)
        MuiText("Row label", variant: .rowLabel)
        MuiText("Body copy runs here.", variant: .body)
        MuiText("Tool label", variant: .toolLabel)
        MuiText("Chip label", variant: .chipLabel)
        MuiText("Eyebrow", variant: .eyebrow)
        MuiText("42.0", variant: .valueChip)
        MuiText("IMG_0001.dng", variant: .filename)
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiText — Color roles") {
    VStack(alignment: .leading, spacing: 8) {
        MuiText("Main", color: .main)
        MuiText("Muted", color: .muted)
        MuiText("Success", color: .success)
        MuiText("Warning", color: .warning)
        MuiText("Error", color: .error)
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiText — Truncation") {
    VStack(alignment: .leading, spacing: 12) {
        MuiText("This is a very long single line of text that should truncate with an ellipsis", truncate: true, block: true)
            .frame(width: 200)
        MuiText("This is a very long run of text that should clamp after two lines instead of one, showing an ellipsis at the end.", lineClamp: 2, block: true)
            .frame(width: 200)
    }
    .padding()
    .background(MuiTokens.bg)
}
