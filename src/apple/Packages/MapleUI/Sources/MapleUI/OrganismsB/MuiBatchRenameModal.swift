// MuiBatchRenameModal.swift — Maple UI Organisms · Modals (unified-
// component-catalog.md §4.4). Template-driven rename with a live preview
// list, built on Overlay Shell from Form Field (template text), Chip Row
// (insertable tokens), Preview List, and Progress. The rename mapping is a
// pure function of `items`, `template`, and `startNumber`, recomputed on
// every keystroke — ported verbatim from the web reference's
// `applyTemplate`.

import SwiftUI

public struct MuiBatchRenameSourceItem: Identifiable, Sendable {
    public let id: String
    public let filename: String
    /// `YYYY-MM-DD` (or any ISO date string — only the leading 10
    /// characters are used) the `{date}` token formats from.
    public let date: String
    public let camera: String?

    public init(id: String, filename: String, date: String, camera: String? = nil) {
        self.id = id
        self.filename = filename
        self.date = date
        self.camera = camera
    }
}

public struct MuiBatchRenameResult: Sendable {
    public let template: String
    public let mapping: [MuiPreviewItem]
}

public struct MuiBatchRenameModal: View {
    private static let seqPadWidth = 3
    public static let tokens: [MuiChip] = [
        MuiChip(id: "date", label: "{date}"),
        MuiChip(id: "seq", label: "{seq}"),
        MuiChip(id: "camera", label: "{camera}"),
    ]

    public let isPresented: Bool
    public let contained: Bool
    public let items: [MuiBatchRenameSourceItem]
    @Binding public var template: String
    public let startNumber: Int
    public let renaming: Bool
    public let progress: Double
    public let renameConfirmed: ((MuiBatchRenameResult) -> Void)?
    public let dismissed: (() -> Void)?

    public init(
        isPresented: Bool,
        contained: Bool = false,
        items: [MuiBatchRenameSourceItem],
        template: Binding<String>,
        startNumber: Int = 1,
        renaming: Bool = false,
        progress: Double = 0,
        renameConfirmed: ((MuiBatchRenameResult) -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.contained = contained
        self.items = items
        self._template = template
        self.startNumber = startNumber
        self.renaming = renaming
        self.progress = progress
        self.renameConfirmed = renameConfirmed
        self.dismissed = dismissed
    }

    private var previewItems: [MuiPreviewItem] {
        Self.previewItems(items: items, template: template, startNumber: startNumber)
    }

    public var body: some View {
        MuiOverlayShell(isPresented: isPresented, accessibilityLabel: "Batch Rename", contained: contained) {
            MuiText("Batch Rename", variant: .sheetTitle)
        } content: {
            VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                MuiFormField(label: "Template", value: $template)
                MuiChipRow(chips: Self.tokens, mode: .select, selectedId: Binding(get: { nil }, set: { insertToken($0) }))
                MuiPreviewList(items: previewItems)
                if renaming {
                    MuiProgress(shape: .bar, value: progress, label: "\(Int(progress))%")
                }
            }
        } footer: {
            HStack {
                Spacer()
                MuiButton(label: "Cancel", variant: .ghost) { dismissed?() }
                MuiButton(label: "Rename", variant: .primary, isLoading: renaming, disabled: renaming) { confirmRename() }
            }
        } dismissed: {
            dismissed?()
        }
    }

    private func insertToken(_ tokenId: String?) {
        guard let tokenId, let token = Self.tokens.first(where: { $0.id == tokenId }) else { return }
        template += token.label
    }

    private func confirmRename() {
        renameConfirmed?(MuiBatchRenameResult(template: template, mapping: previewItems))
    }

    // MARK: - Pure logic (unit-testable without a live view)

    public static func previewItems(items: [MuiBatchRenameSourceItem], template: String, startNumber: Int) -> [MuiPreviewItem] {
        items.enumerated().map { index, item in
            MuiPreviewItem(id: item.id, before: item.filename, after: applyTemplate(template, item: item, seq: startNumber + index))
        }
    }

    static func applyTemplate(_ template: String, item: MuiBatchRenameSourceItem, seq: Int) -> String {
        let dateText = formattedDate(item.date)
        let seqText = String(format: "%0\(seqPadWidth)d", seq)
        return template
            .replacingOccurrences(of: "{date}", with: dateText)
            .replacingOccurrences(of: "{seq}", with: seqText)
            .replacingOccurrences(of: "{camera}", with: item.camera ?? "")
    }

    private static func formattedDate(_ iso: String) -> String {
        String(iso.prefix(10))
    }
}

#Preview("MuiBatchRenameModal") {
    struct Demo: View {
        @State private var open = false
        @State private var template = "{date}_{seq}"
        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiButton(label: "Open Batch Rename", variant: .primary) { open = true }
                MuiBatchRenameModal(
                    isPresented: open,
                    items: [
                        MuiBatchRenameSourceItem(id: "1", filename: "IMG_0042.dng", date: "2026-08-01", camera: "SonyA7IV"),
                        MuiBatchRenameSourceItem(id: "2", filename: "IMG_0043.dng", date: "2026-08-01", camera: "SonyA7IV"),
                    ],
                    template: $template,
                    dismissed: { open = false }
                )
            }
            .frame(width: 420, height: 340)
        }
    }
    return Demo()
}
