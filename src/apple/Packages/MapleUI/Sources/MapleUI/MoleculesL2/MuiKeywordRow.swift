// MuiKeywordRow.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Editable tag chips, built from Chip Row, Input. Chip
// Row's `mode` is a single-choice enum (`.select`/`.removable`/
// `.editable`), but keywords need both removal AND adding at once, so this
// composes Chip Row in `.removable` mode for the existing tags plus its
// own trailing add-Input — the same "draft + commit" shape Chip Row's own
// `.editable` mode uses internally.

import SwiftUI

public struct MuiKeywordRow: View {
    public let keywords: [MuiChip]
    public let addPlaceholder: String
    public let removed: ((String) -> Void)?
    public let added: ((String) -> Void)?

    @State private var draft = ""

    public init(
        keywords: [MuiChip],
        addPlaceholder: String = "+ add",
        removed: ((String) -> Void)? = nil,
        added: ((String) -> Void)? = nil
    ) {
        self.keywords = keywords
        self.addPlaceholder = addPlaceholder
        self.removed = removed
        self.added = added
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
            if !keywords.isEmpty {
                MuiChipRow(chips: keywords, mode: .removable, removed: removed)
            }
            MuiInput(value: $draft, accessibilityLabel: addPlaceholder, placeholder: addPlaceholder, size: .sm, onCommit: commitDraft)
                .frame(maxWidth: 200)
        }
    }

    private func commitDraft() {
        guard let next = Self.addResult(draft: draft) else { return }
        added?(next)
        draft = ""
    }

    /// The keyword to add for a committed draft string — `nil` when the
    /// trimmed draft is empty, so the caller skips emitting `added` for a
    /// blank submission. Public + static so this is unit-testable without
    /// rendering a view.
    public static func addResult(draft: String) -> String? {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

#Preview("MuiKeywordRow") {
    MuiKeywordRow(keywords: [
        MuiChip(id: "1", label: "landscape"),
        MuiChip(id: "2", label: "wildlife"),
    ])
    .padding()
    .background(MuiTokens.bg)
}
