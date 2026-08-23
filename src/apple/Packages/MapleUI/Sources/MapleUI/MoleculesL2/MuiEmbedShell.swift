// MuiEmbedShell.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Frame for embedded content, built from Page Header,
// Progress, Icon.

import SwiftUI

public struct MuiEmbedShell<Content: View>: View {
    public let title: String
    public let loading: Bool
    /// A small leading status glyph next to the title, e.g. a recording
    /// indicator for a live embed. `nil` shows nothing.
    public let statusIcon: String?
    public let statusLabel: String?
    public let showBack: Bool
    public let back: (() -> Void)?
    @ViewBuilder public let content: Content

    public init(
        title: String,
        loading: Bool = false,
        statusIcon: String? = nil,
        statusLabel: String? = nil,
        showBack: Bool = true,
        back: (() -> Void)? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.loading = loading
        self.statusIcon = statusIcon
        self.statusLabel = statusLabel
        self.showBack = showBack
        self.back = back
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MuiPageHeader(title: title, showBack: showBack, back: back)

            if let statusIcon {
                HStack(spacing: MuiTokens.spacingXs) {
                    MuiIcon(name: statusIcon, size: .sm, color: MuiTokens.primary)
                    if let statusLabel {
                        MuiText(statusLabel, variant: .toolLabel, color: .muted)
                    }
                }
                .padding(.horizontal, MuiTokens.spacingMd)
                .padding(.bottom, MuiTokens.spacingXs)
            }

            if loading {
                MuiProgress(shape: .bar, size: .sm)
                    .padding(.horizontal, MuiTokens.spacingMd)
                    .padding(.bottom, MuiTokens.spacingXs)
            }

            content
                .padding(MuiTokens.spacingMd)
        }
    }
}

#Preview("MuiEmbedShell") {
    MuiEmbedShell(title: "Live view", statusIcon: "dot.radiowaves.left.and.right", statusLabel: "Connected") {
        MuiText("Embedded content goes here.", variant: .body, color: .muted)
    }
    .background(MuiTokens.bg)
}
