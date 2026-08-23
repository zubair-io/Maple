// MuiChat.swift — Maple UI Organisms · Communication (unified-component-
// catalog.md §4.7). A conversation surface — message history, a typing
// indicator, and an @-mention composer — built from Chat Message, Typing
// Indicator, Input, Suggestion Menu. All state (messages, who's typing, who
// can be mentioned) comes from inputs; there's no networking here.
//
// Mention detection lives in `MuiChatMentionMath`, shared and unit-tested
// with the algorithm the web reference uses.

import SwiftUI

public struct MuiChatMessageData: Identifiable, Sendable {
    public let id: String
    public let author: String
    public let text: String
    public let sentAt: Date
    public let own: Bool

    public init(id: String, author: String, text: String, sentAt: Date, own: Bool = false) {
        self.id = id
        self.author = author
        self.text = text
        self.sentAt = sentAt
        self.own = own
    }
}

public struct MuiChat: View {
    public let messages: [MuiChatMessageData]
    public let othersTyping: Bool
    public let typingUserName: String
    public let mentionableUsers: [MuiMentionableUser]
    @Binding public var composerValue: String
    public let messageSent: ((String) -> Void)?
    public let mentionSelected: ((String) -> Void)?

    @State private var suggestionsOpen = false

    public init(
        messages: [MuiChatMessageData],
        othersTyping: Bool = false,
        typingUserName: String = "Someone",
        mentionableUsers: [MuiMentionableUser],
        composerValue: Binding<String>,
        messageSent: ((String) -> Void)? = nil,
        mentionSelected: ((String) -> Void)? = nil
    ) {
        self.messages = messages
        self.othersTyping = othersTyping
        self.typingUserName = typingUserName
        self.mentionableUsers = mentionableUsers
        self._composerValue = composerValue
        self.messageSent = messageSent
        self.mentionSelected = mentionSelected
    }

    private var mentionQuery: String? {
        MuiChatMentionMath.mentionQuery(composerValue: composerValue)
    }

    private var suggestions: [MuiMentionableUser] {
        MuiChatMentionMath.suggestions(query: mentionQuery, users: mentionableUsers)
    }

    public var body: some View {
        VStack(spacing: 0) {
            if messages.isEmpty {
                MuiEmptyState(icon: "bubble.left.and.bubble.right", title: "No messages yet", message: "Start the conversation.")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                        ForEach(messages) { message in
                            MuiChatMessage(author: message.author, text: message.text, sentAt: message.sentAt, own: message.own)
                        }
                        if othersTyping {
                            MuiTypingIndicator(name: typingUserName)
                        }
                    }
                    .padding(MuiTokens.spacingMd)
                }
            }

            MuiDivider()

            MuiSuggestionMenu(
                open: $suggestionsOpen,
                items: suggestions.map { MuiSuggestionItem(id: $0.id, label: $0.name) },
                select: selectMention
            ) {
                MuiInput(value: $composerValue, accessibilityLabel: "Message", placeholder: "Message… (@ to mention)", onCommit: send)
                    .onChange(of: composerValue) { _, _ in
                        suggestionsOpen = mentionQuery != nil && !suggestions.isEmpty
                    }
            }
            .padding(MuiTokens.spacingMd)
        }
    }

    private func selectMention(_ userId: String) {
        guard let user = mentionableUsers.first(where: { $0.id == userId }) else { return }
        composerValue = MuiChatMentionMath.applyMention(composerValue: composerValue, userName: user.name)
        mentionSelected?(userId)
    }

    private func send() {
        guard let trimmed = Self.trimmedNonEmpty(composerValue) else { return }
        messageSent?(trimmed)
        composerValue = ""
    }

    /// The message to send — `nil` when the trimmed composer text is blank,
    /// so the caller skips emitting `messageSent` for an empty submission.
    /// Public + static so this is unit-testable without rendering a view.
    public static func trimmedNonEmpty(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

#Preview("MuiChat") {
    struct Demo: View {
        @State private var draft = ""
        var body: some View {
            MuiChat(
                messages: [
                    MuiChatMessageData(id: "1", author: "Ada Lovelace", text: "Can you export the Iceland set?", sentAt: Date().addingTimeInterval(-300)),
                    MuiChatMessageData(id: "2", author: "You", text: "On it now.", sentAt: Date().addingTimeInterval(-60), own: true),
                ],
                othersTyping: true,
                typingUserName: "Ada",
                mentionableUsers: [MuiMentionableUser(id: "1", name: "Ada Lovelace"), MuiMentionableUser(id: "2", name: "Grace Hopper")],
                composerValue: $draft
            )
            .frame(width: 320, height: 320)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
