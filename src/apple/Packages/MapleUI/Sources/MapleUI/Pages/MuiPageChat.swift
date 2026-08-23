// MuiPageChat.swift — Maple UI Pages (unified-component-catalog.md §6).
// Split Layout hosting Chat in the Center region and a Thread Panel in
// Detail — a shared-album conversation with a pinned reply thread beside
// it. The Sidebar region goes unused (zero width): the catalog lists only
// Chat and Thread Panel as this page's organisms, and Split Layout has no
// "two region" mode, so the cleanest fit is a zero-width Sidebar rather
// than introducing a Navigation organism the catalog doesn't call for.
//
// Cross-organism wiring that's genuinely new at this tier: Chat's
// composer only clears itself on send (per its own organism contract) —
// it does not append to `messages`, since Chat treats that as a plain
// one-way input the caller owns. This page owns the append: sending a
// message (main chat or thread reply) appends a new entry to that
// surface's own message list. `MuiPageChat.appendedChatMessages` /
// `appendedThreadMessages` are the pure reducers behind both appends.

import SwiftUI

public struct MuiPageChat: View {
    @State private var messages: [MuiChatMessageData]
    @State private var threadMessages: [MuiThreadMessage]
    @State private var composerValue = ""
    @State private var threadDraft = ""

    public let mentionableUsers: [MuiMentionableUser]

    public init(
        messages: [MuiChatMessageData] = MuiPageChat.defaultMessages,
        threadMessages: [MuiThreadMessage] = MuiPageChat.defaultThreadMessages,
        mentionableUsers: [MuiMentionableUser] = MuiPageChat.defaultMentionableUsers
    ) {
        self._messages = State(initialValue: messages)
        self._threadMessages = State(initialValue: threadMessages)
        self.mentionableUsers = mentionableUsers
    }

    public var body: some View {
        MuiSplitLayout(sidebarWidth: .constant(0), sidebarMin: 0, sidebarMax: 0) {
            EmptyView()
        } center: {
            MuiChat(
                messages: messages,
                mentionableUsers: mentionableUsers,
                composerValue: $composerValue,
                messageSent: { text in messages = Self.appendedChatMessages(messages, text: text) }
            )
        } detail: {
            MuiThreadPanel(
                messages: threadMessages,
                draft: $threadDraft,
                sent: { text in threadMessages = Self.appendedThreadMessages(threadMessages, text: text) }
            )
        }
        .background(MuiTokens.bg)
    }

    // MARK: - Pure wiring logic (unit-testable without a live view)

    /// `messages` with a new own-authored entry appended for `text` —
    /// mirrors the shape Chat's own `MuiChatMessageData` needs (an id, a
    /// send time, and `own: true` so it renders on the sender's side).
    public static func appendedChatMessages(_ messages: [MuiChatMessageData], text: String, sentAt: Date = Date()) -> [MuiChatMessageData] {
        messages + [MuiChatMessageData(id: nextId(after: messages.map(\.id)), author: "You", text: text, sentAt: sentAt, own: true)]
    }

    /// Same append, for the Thread Panel's reply list.
    public static func appendedThreadMessages(_ messages: [MuiThreadMessage], text: String, sentAt: Date = Date()) -> [MuiThreadMessage] {
        messages + [MuiThreadMessage(id: nextId(after: messages.map(\.id)), author: "You", sentAt: sentAt, text: text, own: true)]
    }

    private static func nextId(after existingIds: [String]) -> String {
        "\((existingIds.compactMap { Int($0) }.max() ?? existingIds.count) + 1)"
    }

    // MARK: - Default mock data

    public static let defaultMessages: [MuiChatMessageData] = [
        MuiChatMessageData(id: "1", author: "Ada Lovelace", text: "Can you export the Iceland set as JPEGs for the client?", sentAt: Date().addingTimeInterval(-900)),
        MuiChatMessageData(id: "2", author: "You", text: "On it — Display P3, full res.", sentAt: Date().addingTimeInterval(-600), own: true),
        MuiChatMessageData(id: "3", author: "Grace Hopper", text: "Can we get the Faroe set in the same batch?", sentAt: Date().addingTimeInterval(-120)),
    ]

    public static let defaultThreadMessages: [MuiThreadMessage] = [
        MuiThreadMessage(id: "1", author: "Ada Lovelace", sentAt: Date().addingTimeInterval(-840), text: "Deadline is Friday if that's doable."),
        MuiThreadMessage(id: "2", author: "You", sentAt: Date().addingTimeInterval(-540), text: "Friday works, exporting now.", own: true),
    ]

    public static let defaultMentionableUsers: [MuiMentionableUser] = [
        MuiMentionableUser(id: "1", name: "Ada Lovelace"),
        MuiMentionableUser(id: "2", name: "Grace Hopper"),
    ]
}

#Preview("MuiPageChat") {
    MuiPageChat()
        .frame(width: 720, height: 480)
}
