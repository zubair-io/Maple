// MuiRichTextEditor.swift — Maple UI Organisms · Editing surfaces
// (unified-component-catalog.md §4.5). A real, genuinely-editable
// `TextEditor` document body with a formatting Bubble Menu and a
// `/`-triggered Command Menu, built from Bubble Menu, Command Menu, Code
// Block.
//
// See `MuiRichTextEditorMath`'s header for why "on selection"/"at the
// caret" are approximated as "on the trailing word"/"at line end" — this
// package's iOS 17 / macOS 14 floor predates `TextEditor`'s
// selection-binding initializer. The formatting bar shows whenever the
// editor is focused (the closest available surrogate for "there's an
// active selection") rather than only while text is actually selected.

import SwiftUI

public struct MuiRichTextEditor: View {
    @Binding public var value: String
    public let commandExecuted: ((String) -> Void)?

    @FocusState private var editorFocused: Bool
    @State private var bubbleOpen = false
    @State private var commandOpen = false

    private static let bubbleEntries: [MuiBubbleMenuEntry] = [
        .item(MuiBubbleMenuItem(id: "bold", icon: "bold", label: "Bold")),
        .item(MuiBubbleMenuItem(id: "italic", icon: "italic", label: "Italic")),
        .divider,
        .item(MuiBubbleMenuItem(id: "link", icon: "link", label: "Link")),
    ]

    private static let slashCommands: [MuiCommandItem] = [
        MuiCommandItem(id: "heading", label: "Heading", icon: "textformat.size"),
        MuiCommandItem(id: "code", label: "Code block", icon: "chevron.left.forwardslash.chevron.right"),
        MuiCommandItem(id: "bulleted-list", label: "Bulleted list", icon: "list.bullet"),
    ]

    public init(value: Binding<String>, commandExecuted: ((String) -> Void)? = nil) {
        self._value = value
        self.commandExecuted = commandExecuted
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            MuiCommandMenu(open: $commandOpen, commands: Self.slashCommands, select: applyCommand) {
                MuiBubbleMenu(open: $bubbleOpen, entries: Self.bubbleEntries, itemSelected: applyFormat) {
                    TextEditor(text: $value)
                        .scrollContentBackground(.hidden)
                        .font(.system(size: 14))
                        .foregroundStyle(MuiTokens.textMain)
                        .focused($editorFocused)
                        .frame(minHeight: 140)
                        .padding(MuiTokens.spacingSm)
                        .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusMd, style: .continuous))
                        .onChange(of: value) { _, newValue in
                            commandOpen = MuiRichTextEditorMath.slashCommandActive(text: newValue)
                        }
                        .onChange(of: editorFocused) { _, focused in
                            bubbleOpen = focused && !value.isEmpty
                        }
                }
            }

            if !codeBlocks.isEmpty {
                MuiText("Inserted code blocks", variant: .toolLabel, color: .muted)
                ForEach(Array(codeBlocks.enumerated()), id: \.offset) { _, code in
                    MuiCodeBlock(code: code, language: nil)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Document editor")
    }

    /// Fenced-code segments (```…```) currently in `value`, extracted for
    /// the read-only preview below the editable body.
    private var codeBlocks: [String] {
        Self.extractCodeBlocks(from: value)
    }

    private func applyFormat(_ id: String) {
        let marker: String
        switch id {
        case "bold": marker = "**"
        case "italic": marker = "*"
        case "link": marker = "_"
        default: return
        }
        value = MuiRichTextEditorMath.wrapLastToken(text: value, marker: marker)
        bubbleOpen = false
    }

    private func applyCommand(_ id: String) {
        guard let next = MuiRichTextEditorMath.applyCommand(text: value, commandId: id) else { return }
        value = next
        commandOpen = false
        commandExecuted?(id)
    }

    /// Extracts the content of every ` ```…``` ` fenced block in `text`.
    /// Public + static so this is unit-testable without rendering a view.
    public static func extractCodeBlocks(from text: String) -> [String] {
        let parts = text.components(separatedBy: "```")
        guard parts.count > 2 else { return [] }
        return stride(from: 1, to: parts.count, by: 2).map { parts[$0] }
    }
}

#Preview("MuiRichTextEditor") {
    struct Demo: View {
        @State private var value = "A lone hiker crosses a black-sand beach at dusk."
        var body: some View {
            MuiRichTextEditor(value: $value)
                .frame(width: 320)
                .padding()
                .background(MuiTokens.bg)
        }
    }
    return Demo()
}
