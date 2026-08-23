// MuiSettingsRow.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Collapsible labeled setting, built from Collapsible,
// Icon, Text, Divider.

import SwiftUI

public struct MuiSettingsRow<Content: View>: View {
    public let label: String
    public let icon: String?
    public let description: String?
    @Binding public var open: Bool
    /// Renders a trailing divider below the row — off by default so a
    /// caller stacking several rows in a list can supply the divider
    /// itself once, between rows, rather than doubling it up.
    public let showDivider: Bool
    @ViewBuilder public let content: Content

    public init(
        label: String,
        icon: String? = nil,
        description: String? = nil,
        open: Binding<Bool>,
        showDivider: Bool = true,
        @ViewBuilder content: () -> Content = { EmptyView() }
    ) {
        self.label = label
        self.icon = icon
        self.description = description
        self._open = open
        self.showDivider = showDivider
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
                if let icon {
                    MuiIcon(name: icon, size: .sm, color: MuiTokens.textMuted)
                        .padding(.top, 2)
                }

                MuiCollapsible(label: label, open: $open) {
                    VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                        if let description {
                            MuiText(description, variant: .body, color: .muted, block: true)
                        }
                        content
                    }
                }
            }

            if showDivider {
                MuiDivider()
                    .padding(.top, MuiTokens.spacingSm)
            }
        }
    }
}

#Preview("MuiSettingsRow") {
    struct Demo: View {
        @State private var openA = true
        @State private var openB = false

        var body: some View {
            VStack(spacing: 0) {
                MuiSettingsRow(label: "Denoise", icon: "wand.and.stars", description: "Reduce sensor noise on import.", open: $openA) {
                    MuiText("Strength: Medium", variant: .body, color: .muted)
                }
                MuiSettingsRow(label: "Backups", icon: "externaldrive", open: $openB, showDivider: false) {
                    MuiText("No destination configured.", variant: .body, color: .muted)
                }
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
