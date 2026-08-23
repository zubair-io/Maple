// MuiChatMentionMath.swift — pure @-mention detection for `MuiChat`. Ported
// from the web reference's `mentionQuery`/`suggestionItems`/
// `onMentionSelect` (mui-chat.component.ts): the trigger is whatever comes
// after the LAST `@` in the composer text, as long as no whitespace has
// been typed since — the usual "still composing a handle" rule.

import Foundation

public struct MuiMentionableUser: Identifiable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

enum MuiChatMentionMath {
    /// The in-progress mention query — text after the last `@`, as long as
    /// nothing whitespace has been typed since. `nil` when there's no
    /// active mention (no `@`, or whitespace already closed it out).
    static func mentionQuery(composerValue: String) -> String? {
        guard let atIndex = composerValue.lastIndex(of: "@") else { return nil }
        let after = composerValue[composerValue.index(after: atIndex)...]
        guard !after.contains(where: { $0.isWhitespace }) else { return nil }
        return String(after)
    }

    /// Mentionable users whose name contains `query`, case-insensitively —
    /// empty when `query` is `nil`.
    static func suggestions(query: String?, users: [MuiMentionableUser]) -> [MuiMentionableUser] {
        guard let query else { return [] }
        let lower = query.lowercased()
        return users.filter { $0.name.lowercased().contains(lower) }
    }

    /// The composer text after replacing the in-progress `@`-trigger with
    /// the selected user's full mention — unchanged when there's no active
    /// `@` to replace.
    static func applyMention(composerValue: String, userName: String) -> String {
        guard let atIndex = composerValue.lastIndex(of: "@") else { return composerValue }
        return String(composerValue[..<atIndex]) + "@" + userName + " "
    }
}
