// MuiLink.swift — Maple UI Link atom.
// Contract: docs/design/maple-ui/components/link.md

import SwiftUI

/// An inline hyperlink — text that navigates, embedded inside a sentence or
/// a metadata row (link.md §Purpose). Distinct from `MuiButton`: never
/// carries filled-control visual weight.
///
/// `external: true` renders the trailing affordance icon (link.md
/// §Variants) and, when no `action` closure is supplied, opens `href`
/// through the system's `openURL` — the native equivalent of the web's
/// `target="_blank"` + `rel="noopener noreferrer"` pair, since a system-level
/// open never hands the destination a `window.opener`-style back-reference.
public struct MuiLink: View {
    public let title: String
    public let href: String
    public let external: Bool
    public let disabled: Bool
    public let action: (() -> Void)?

    @Environment(\.openURL) private var openURL
    @State private var isHovering = false
    @State private var isVisited = false
    @FocusState private var isFocused: Bool

    public init(
        title: String,
        href: String,
        external: Bool = false,
        disabled: Bool = false,
        action: (() -> Void)? = nil
    ) {
        self.title = title
        self.href = href
        self.external = external
        self.disabled = disabled
        self.action = action
    }

    public var body: some View {
        Button {
            guard !disabled else { return }
            isVisited = true
            if let action {
                action()
            } else if let url = URL(string: href) {
                openURL(url)
            }
        } label: {
            HStack(spacing: 4) {
                Text(title).underline()
                if external {
                    MuiIcon(name: "arrow.up.right", size: .xs, color: color)
                }
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(color)
        .opacity(disabled ? 0.5 : 1)
        .focused($isFocused)
        .overlay(
            RoundedRectangle(cornerRadius: MuiTokens.radiusXs, style: .continuous)
                .stroke(isFocused ? MuiTokens.primary.opacity(0.2) : .clear, lineWidth: 2)
                .padding(-2)
        )
        .onHover { isHovering = $0 }
        .disabled(disabled)
        .accessibilityLabel(title)
        .accessibilityAddTraits(.isLink)
    }

    private var color: Color {
        if disabled { return MuiTokens.textMuted }
        if isVisited { return MuiTokens.textMuted }
        // Hover lightens the primary tint rather than swapping to a second
        // hardcoded hue (link.md §States).
        return isHovering ? MuiTokens.primary.opacity(0.8) : MuiTokens.primary
    }
}

#Preview("MuiLink — Internal vs external") {
    VStack(alignment: .leading, spacing: 12) {
        MuiLink(title: "View details", href: "maple://asset/1")
        MuiLink(title: "Open source folder", href: "https://example.com", external: true)
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiLink — Disabled") {
    MuiLink(title: "Unavailable", href: "maple://asset/1", disabled: true)
        .padding()
        .background(MuiTokens.bg)
}
