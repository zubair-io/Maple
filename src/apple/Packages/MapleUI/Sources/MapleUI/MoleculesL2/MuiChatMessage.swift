// MuiChatMessage.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). One message bubble, built from Avatar, Text, Timestamp.

import SwiftUI

public struct MuiChatMessage: View {
    public let author: String
    public let text: String
    public let sentAt: Date
    /// Renders right-aligned, without a leading avatar, for the local
    /// user's own messages.
    public let own: Bool

    public init(author: String, text: String, sentAt: Date, own: Bool = false) {
        self.author = author
        self.text = text
        self.sentAt = sentAt
        self.own = own
    }

    public var body: some View {
        HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
            if own { Spacer(minLength: 40) }

            if !own {
                MuiAvatar(name: author, size: .sm)
            }

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: MuiTokens.spacingXs) {
                    if !own {
                        MuiText(author, variant: .chipLabel)
                    }
                    MuiTimestamp(value: sentAt, format: .relative)
                }
                MuiText(text, variant: .body, block: true)
            }
            .padding(MuiTokens.spacingSm)
            .background(own ? MuiTokens.primaryDim : MuiTokens.surfaceAlt, in: RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous))

            if !own { Spacer(minLength: 40) }
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview("MuiChatMessage") {
    VStack(alignment: .leading, spacing: 12) {
        MuiChatMessage(author: "Ada Lovelace", text: "Can you export the Iceland set?", sentAt: Date().addingTimeInterval(-300))
        MuiChatMessage(author: "You", text: "On it now.", sentAt: Date().addingTimeInterval(-60), own: true)
    }
    .padding()
    .frame(width: 340)
    .background(MuiTokens.bg)
}
