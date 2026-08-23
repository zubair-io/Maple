// MuiCardDetailModal.swift — Maple UI Organisms · Modals (unified-
// component-catalog.md §4.4). Expanded board-card editor — title, priority,
// body — built on Overlay Shell from Form Field, Chip Row, and this wave's
// own Rich Text Editor for the body (the web reference falls back to a
// plain `contenteditable` block because Rich Text Editor wasn't available
// at build time in that wave; this Apple wave ships both in the same pass,
// so Card Detail composes the real thing).
//
// The card's text field is named `bodyText`, not `body` — SwiftUI's `View`
// protocol reserves `body` for the view's own content.

import SwiftUI

public struct MuiCardDetailData: Sendable {
    public let title: String
    public let priority: String?
    public let bodyText: String
}

public struct MuiCardDetailModal: View {
    public static let defaultPriorities: [MuiChip] = [
        MuiChip(id: "low", label: "Low"),
        MuiChip(id: "medium", label: "Medium"),
        MuiChip(id: "high", label: "High"),
    ]

    public let isPresented: Bool
    public let contained: Bool
    @Binding public var title: String
    public let priorityOptions: [MuiChip]
    @Binding public var selectedPriority: String?
    @Binding public var bodyText: String
    public let saved: ((MuiCardDetailData) -> Void)?
    public let dismissed: (() -> Void)?

    public init(
        isPresented: Bool,
        contained: Bool = false,
        title: Binding<String>,
        priorityOptions: [MuiChip] = MuiCardDetailModal.defaultPriorities,
        selectedPriority: Binding<String?>,
        bodyText: Binding<String>,
        saved: ((MuiCardDetailData) -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.contained = contained
        self._title = title
        self.priorityOptions = priorityOptions
        self._selectedPriority = selectedPriority
        self._bodyText = bodyText
        self.saved = saved
        self.dismissed = dismissed
    }

    private var canSave: Bool {
        !title.trimmingCharacters(in: .whitespaces).isEmpty
    }

    public var body: some View {
        MuiOverlayShell(isPresented: isPresented, size: .lg, accessibilityLabel: "Card Detail", contained: contained) {
            MuiText("Card Detail", variant: .sheetTitle)
        } content: {
            VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                MuiFormField(label: "Title", value: $title, required: true)
                VStack(alignment: .leading, spacing: 4) {
                    MuiText("Priority", variant: .toolLabel, color: .muted)
                    MuiChipRow(chips: priorityOptions, mode: .select, selectedId: $selectedPriority)
                }
                MuiRichTextEditor(value: $bodyText)
            }
        } footer: {
            HStack {
                Spacer()
                MuiButton(label: "Cancel", variant: .ghost) { dismissed?() }
                MuiButton(label: "Save", variant: .primary, disabled: !canSave) { save() }
            }
        } dismissed: {
            dismissed?()
        }
    }

    private func save() {
        guard canSave else { return }
        saved?(MuiCardDetailData(title: title, priority: selectedPriority, bodyText: bodyText))
    }
}

#Preview("MuiCardDetailModal") {
    struct Demo: View {
        @State private var open = false
        @State private var title = "Retouch hero shot"
        @State private var priority: String? = "high"
        @State private var bodyText = "Client wants the sky punchier."
        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiButton(label: "Open Card Detail", variant: .primary) { open = true }
                MuiCardDetailModal(isPresented: open, title: $title, selectedPriority: $priority, bodyText: $bodyText, dismissed: { open = false })
            }
            .frame(width: 420, height: 420)
        }
    }
    return Demo()
}
