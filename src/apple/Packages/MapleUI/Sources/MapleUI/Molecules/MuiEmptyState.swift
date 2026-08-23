// MuiEmptyState.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.3). Icon, title, message, optional action — built from Icon, Text,
// Button.

import SwiftUI

public struct MuiEmptyState: View {
    public let icon: String
    public let title: String
    public let message: String?
    public let actionLabel: String?
    public let actionPressed: (() -> Void)?

    public init(
        icon: String,
        title: String,
        message: String? = nil,
        actionLabel: String? = nil,
        actionPressed: (() -> Void)? = nil
    ) {
        self.icon = icon
        self.title = title
        self.message = message
        self.actionLabel = actionLabel
        self.actionPressed = actionPressed
    }

    public var body: some View {
        VStack(spacing: MuiTokens.spacingSm) {
            MuiIcon(name: icon, size: .xl, color: MuiTokens.textMuted)
            MuiText(title, variant: .rowLabel, block: true)
                .multilineTextAlignment(.center)
            if let message {
                MuiText(message, variant: .body, color: .muted, block: true)
                    .multilineTextAlignment(.center)
            }
            if let actionLabel {
                MuiButton(label: actionLabel, variant: .secondary, size: .sm) { actionPressed?() }
                    .padding(.top, MuiTokens.spacingXs)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(MuiTokens.spacingLg)
        .accessibilityElement(children: .combine)
    }
}

#Preview("MuiEmptyState") {
    VStack(spacing: 24) {
        MuiEmptyState(icon: "photo.on.rectangle.angled", title: "No photos yet", message: "Import a folder to get started.", actionLabel: "Import")
        MuiEmptyState(icon: "magnifyingglass", title: "No results")
    }
    .padding()
    .background(MuiTokens.bg)
}
