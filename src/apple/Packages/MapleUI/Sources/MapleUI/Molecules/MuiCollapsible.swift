// MuiCollapsible.swift — Maple UI Molecules-L1 (unified-component-
// catalog.md §2.5; Built from: Icon, Text). A disclosure header + animated
// content region.

import SwiftUI

public struct MuiCollapsible<Content: View>: View {
    public let label: String
    @Binding public var open: Bool
    @ViewBuilder public let content: Content

    public init(label: String, open: Binding<Bool>, @ViewBuilder content: () -> Content) {
        self.label = label
        self._open = open
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                open.toggle()
            } label: {
                HStack(spacing: MuiTokens.spacingSm) {
                    MuiIcon(name: "chevron.right", size: .sm, color: MuiTokens.textMuted)
                        .rotationEffect(.degrees(open ? 90 : 0))
                    MuiText(label, variant: .rowLabel)
                    Spacer()
                }
                .padding(.vertical, MuiTokens.spacingXs)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(open ? "Expanded" : "Collapsed")

            if open {
                content
                    .padding(.leading, MuiTokens.spacingLg)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(MuiTokens.Motion.groupSwap, value: open)
    }
}

#Preview("MuiCollapsible") {
    struct Demo: View {
        @State private var open = true

        var body: some View {
            MuiCollapsible(label: "Advanced options", open: $open) {
                VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                    MuiText("Denoise strength", variant: .body, color: .muted)
                    MuiText("Chroma smoothing", variant: .body, color: .muted)
                }
            }
        }
    }
    return Demo()
        .padding()
        .background(MuiTokens.bg)
}
