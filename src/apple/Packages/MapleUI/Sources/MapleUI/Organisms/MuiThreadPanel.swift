// MuiThreadPanel.swift — Maple UI Organisms · Inspectors & panels
// (unified-component-catalog.md §4.3). Reply thread, built from Chat
// Message, Input, Button.

import SwiftUI

public struct MuiThreadMessage: Identifiable, Sendable {
    public let id: String
    public let author: String
    public let sentAt: Date
    public let text: String
    public let own: Bool

    public init(id: String, author: String, sentAt: Date, text: String, own: Bool = false) {
        self.id = id
        self.author = author
        self.sentAt = sentAt
        self.text = text
        self.own = own
    }
}

public struct MuiThreadPanel: View {
    public let messages: [MuiThreadMessage]
    public let loading: Bool
    public let sending: Bool
    @Binding public var draft: String
    public let sent: ((String) -> Void)?

    public init(
        messages: [MuiThreadMessage],
        loading: Bool = false,
        sending: Bool = false,
        draft: Binding<String> = .constant(""),
        sent: ((String) -> Void)? = nil
    ) {
        self.messages = messages
        self.loading = loading
        self.sending = sending
        self._draft = draft
        self.sent = sent
    }

    public var body: some View {
        VStack(spacing: 0) {
            if loading {
                MuiSpinner(placement: .centered, label: "Loading thread")
            } else if messages.isEmpty {
                MuiEmptyState(icon: "bubble.left.and.bubble.right", title: "No replies yet", message: "Start the conversation.")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                        ForEach(messages) { message in
                            MuiChatMessage(author: message.author, text: message.text, sentAt: message.sentAt, own: message.own)
                        }
                    }
                    .padding(MuiTokens.spacingMd)
                }
            }

            MuiDivider()

            HStack(spacing: MuiTokens.spacingSm) {
                MuiInput(value: $draft, accessibilityLabel: "Reply", placeholder: "Reply…", disabled: sending, onCommit: send)
                MuiButton(label: "Send", variant: .primary, size: .sm, isLoading: sending, disabled: sending) { send() }
            }
            .padding(MuiTokens.spacingMd)
        }
    }

    private func send() {
        guard let trimmed = Self.trimmedNonEmpty(draft), !sending else { return }
        sent?(trimmed)
        draft = ""
    }

    // MARK: - Pure logic (unit-testable without a live view)

    public static func trimmedNonEmpty(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

#Preview("MuiThreadPanel") {
    struct Demo: View {
        @State private var draft = ""
        var body: some View {
            MuiThreadPanel(
                messages: [
                    MuiThreadMessage(id: "1", author: "Alex", sentAt: Date().addingTimeInterval(-600), text: "Can we crop tighter on this one?"),
                    MuiThreadMessage(id: "2", author: "You", sentAt: Date().addingTimeInterval(-300), text: "Sure, working on it now.", own: true),
                ],
                draft: $draft,
                sent: { _ in }
            )
            .frame(width: 280, height: 320)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}

#Preview("MuiThreadPanel — Loading / Empty") {
    VStack(spacing: 0) {
        MuiThreadPanel(messages: [], loading: true).frame(height: 160)
        MuiDivider()
        MuiThreadPanel(messages: []).frame(height: 160)
    }
    .background(MuiTokens.bg)
}
