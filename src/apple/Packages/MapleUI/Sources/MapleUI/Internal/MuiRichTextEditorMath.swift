// MuiRichTextEditorMath.swift — pure text-transform helpers for
// `MuiRichTextEditor`. SwiftUI's `TextEditor(text:)` initializer (the one
// available at this package's iOS 17 / macOS 14 floor — the
// selection-binding overload is iOS 18+) exposes no live selection range,
// so "format the selection" and "insert at the caret" are approximated as
// "format the trailing word" and "insert at the end of the current line" —
// deterministic, testable stand-ins for the same bubble-menu/slash-command
// UX the web reference drives from a real DOM `Selection`/caret `Range`.

import Foundation

enum MuiRichTextEditorMath {
    /// A `/`-command menu opens once the live text ends with a bare `/`
    /// (nothing typed after it yet) — mirrors the web reference's "still
    /// composing a trigger" rule.
    static func slashCommandActive(text: String) -> Bool {
        text.hasSuffix("/")
    }

    /// Removes the trailing `/` and appends the markdown prefix for
    /// `commandId`, starting a new line first if the text isn't already
    /// empty — `nil` for an unrecognized command id (a no-op).
    static func applyCommand(text: String, commandId: String) -> String? {
        guard text.hasSuffix("/") else { return nil }
        let withoutSlash = String(text.dropLast())
        let prefix: String
        switch commandId {
        case "heading": prefix = "# "
        case "code": prefix = "```\n\n```"
        case "bulleted-list": prefix = "- "
        default: return nil
        }
        return withoutSlash + prefix
    }

    /// Wraps the trailing non-whitespace run of `text` in `marker` on both
    /// sides (the bubble menu's Bold/Italic/Link actions) — a no-op
    /// (returns `text` unchanged) when there's no trailing token to wrap.
    static func wrapLastToken(text: String, marker: String) -> String {
        guard let lastSpace = text.lastIndex(where: { $0.isWhitespace }) else {
            return text.isEmpty ? text : "\(marker)\(text)\(marker)"
        }
        let tokenStart = text.index(after: lastSpace)
        guard tokenStart < text.endIndex else { return text }
        let token = text[tokenStart...]
        return String(text[..<tokenStart]) + marker + token + marker
    }
}
