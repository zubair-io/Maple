// MuiCard.swift — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Image + title + metadata tile, built from Image, Text, Badge.

import SwiftUI

public struct MuiCard: View {
    public let url: URL?
    public let alt: String
    public let title: String
    public let subtitle: String?
    public let badgeLabel: String?
    public let pressed: (() -> Void)?

    public init(
        url: URL?,
        alt: String,
        title: String,
        subtitle: String? = nil,
        badgeLabel: String? = nil,
        pressed: (() -> Void)? = nil
    ) {
        self.url = url
        self.alt = alt
        self.title = title
        self.subtitle = subtitle
        self.badgeLabel = badgeLabel
        self.pressed = pressed
    }

    public var body: some View {
        Button {
            pressed?()
        } label: {
            VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                ZStack(alignment: .topTrailing) {
                    MuiImage(url: url, alt: alt, fit: .fill, radius: .none, aspectRatio: 16.0 / 9.0)
                    if let badgeLabel {
                        MuiBadge(variant: .count, value: badgeLabel)
                            .padding(6)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    MuiText(title, variant: .rowLabel, truncate: true)
                    if let subtitle {
                        MuiText(subtitle, variant: .body, color: .muted, truncate: true)
                    }
                }
                .padding(.horizontal, 2)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(.isButton)
    }
}

#Preview("MuiCard") {
    HStack(alignment: .top, spacing: 16) {
        MuiCard(url: nil, alt: "Trip cover", title: "Iceland 2026", subtitle: "214 photos", badgeLabel: "New")
        MuiCard(url: nil, alt: "Trip cover", title: "Faroe Islands")
    }
    .frame(width: 460)
    .padding()
    .background(MuiTokens.bg)
}
