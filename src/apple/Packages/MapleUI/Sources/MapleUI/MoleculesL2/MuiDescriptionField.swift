// MuiDescriptionField.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Text with override and regenerate, built from Text,
// Input, Button. Displays generated/edited description text; tapping it
// swaps in an Input to override (Return commits, losing focus commits —
// same click-to-edit contract as MuiInlineRenameField/MuiPlaceRow), and a
// Regenerate action asks the caller for a fresh AI-generated value. Unlike
// MuiPlaceRow, an empty commit is allowed here — clearing a description is
// a valid edit.

import SwiftUI

public struct MuiDescriptionField: View {
    @Binding public var value: String
    public let regenerating: Bool
    public let placeholder: String
    public let regenerate: (() -> Void)?
    public let committed: ((String) -> Void)?

    @State private var editing = false
    @State private var draft = ""
    @FocusState private var isFocused: Bool

    public init(
        value: Binding<String>,
        regenerating: Bool = false,
        placeholder: String = "No description yet.",
        regenerate: (() -> Void)? = nil,
        committed: ((String) -> Void)? = nil
    ) {
        self._value = value
        self.regenerating = regenerating
        self.placeholder = placeholder
        self.regenerate = regenerate
        self.committed = committed
    }

    public var body: some View {
        HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
            if editing {
                MuiInput(value: $draft, accessibilityLabel: "Description", onCommit: commit)
                    .focused($isFocused)
                    #if os(macOS)
                    .onExitCommand { editing = false }
                    #endif
                    .onChange(of: isFocused) { _, focused in
                        if !focused { commit() }
                    }
                    .task { isFocused = true }
            } else {
                Button {
                    draft = value
                    editing = true
                } label: {
                    MuiText(value.isEmpty ? placeholder : value, variant: .body, color: .muted, block: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Description")
            }

            MuiButton(label: "Regenerate", variant: .ghost, size: .sm, leadingIcon: "wand.and.stars", isLoading: regenerating) {
                regenerate?()
            }
        }
    }

    private func commit() {
        guard editing else { return }
        editing = false
        guard let next = Self.commitResult(current: value, draft: draft) else { return }
        value = next
        committed?(next)
    }

    /// The committed value for an edit attempt — `nil` when the trimmed
    /// draft is unchanged from the current value (a description is
    /// allowed to commit empty, clearing it, unlike `MuiPlaceRow`). Public
    /// + static so this is unit-testable without rendering a view.
    public static func commitResult(current: String, draft: String) -> String? {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed == current ? nil : trimmed
    }
}

#Preview("MuiDescriptionField") {
    struct Demo: View {
        @State private var text = "A red fox crossing a snowy field at dusk."
        @State private var empty = ""

        var body: some View {
            VStack(alignment: .leading, spacing: 16) {
                MuiDescriptionField(value: $text)
                MuiDescriptionField(value: $empty, regenerating: true)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
