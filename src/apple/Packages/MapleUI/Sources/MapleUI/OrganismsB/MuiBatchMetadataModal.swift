// MuiBatchMetadataModal.swift — Maple UI Organisms · Modals (unified-
// component-catalog.md §4.4). Multi-field metadata editor (copyright,
// keywords, rating) with a confirm-before-apply step, built on Overlay
// Shell from Form Field, Chip Row (keywords), a nested Dialog (confirm
// variant), and Progress.

import SwiftUI

public struct MuiBatchMetadataValues: Sendable {
    public let copyright: String
    public let keywords: [String]
    public let rating: Int
}

public struct MuiBatchMetadataModal: View {
    private static let maxRating = 5

    public let isPresented: Bool
    public let contained: Bool
    public let itemCount: Int
    @Binding public var copyright: String
    @Binding public var keywords: [String]
    @Binding public var rating: Int
    public let applying: Bool
    public let progress: Double
    public let applyRequested: ((MuiBatchMetadataValues) -> Void)?
    public let dismissed: (() -> Void)?

    @State private var confirmOpen = false

    public init(
        isPresented: Bool,
        contained: Bool = false,
        itemCount: Int,
        copyright: Binding<String>,
        keywords: Binding<[String]>,
        rating: Binding<Int>,
        applying: Bool = false,
        progress: Double = 0,
        applyRequested: ((MuiBatchMetadataValues) -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.contained = contained
        self.itemCount = itemCount
        self._copyright = copyright
        self._keywords = keywords
        self._rating = rating
        self.applying = applying
        self.progress = progress
        self.applyRequested = applyRequested
        self.dismissed = dismissed
    }

    private var keywordChips: [MuiChip] {
        keywords.map { MuiChip(id: $0, label: $0) }
    }

    public var body: some View {
        ZStack {
            MuiOverlayShell(isPresented: isPresented, accessibilityLabel: "Batch Metadata", contained: contained) {
                MuiText("Batch Metadata", variant: .sheetTitle)
            } content: {
                VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                    MuiFormField(label: "Copyright", value: $copyright)
                    VStack(alignment: .leading, spacing: 4) {
                        MuiText("Keywords", variant: .toolLabel, color: .muted)
                        MuiChipRow(chips: keywordChips, mode: .editable, removed: removeKeyword, added: addKeyword)
                    }
                    MuiFormField(
                        label: "Rating", value: Binding(get: { "\(rating)" }, set: { commitRating($0) }),
                        numeric: MuiInputNumericConfig(min: 0, max: Double(Self.maxRating), step: 1)
                    )
                    if applying {
                        MuiProgress(shape: .bar, value: progress, label: "\(Int(progress))%")
                    }
                }
            } footer: {
                HStack {
                    Spacer()
                    MuiButton(label: "Cancel", variant: .ghost) { dismissed?() }
                    MuiButton(label: "Apply…", variant: .primary, isLoading: applying, disabled: applying) { confirmOpen = true }
                }
            } dismissed: {
                dismissed?()
            }

            MuiDialog(
                isPresented: confirmOpen,
                title: "Apply metadata?",
                message: Self.confirmMessage(keywordCount: keywords.count, itemCount: itemCount),
                confirmLabel: "Apply",
                confirmed: { _ in onConfirmed() },
                dismissed: { confirmOpen = false }
            )
        }
    }

    private func addKeyword(_ label: String) {
        guard !keywords.contains(label) else { return }
        keywords.append(label)
    }

    private func removeKeyword(_ id: String) {
        keywords.removeAll { $0 == id }
    }

    private func commitRating(_ raw: String) {
        guard let parsed = Int(raw) else { return }
        rating = min(Self.maxRating, max(0, parsed))
    }

    private func onConfirmed() {
        confirmOpen = false
        applyRequested?(MuiBatchMetadataValues(copyright: copyright, keywords: keywords, rating: rating))
    }

    /// The confirm dialog's message — public + static so this is
    /// unit-testable without rendering a view.
    public static func confirmMessage(keywordCount: Int, itemCount: Int) -> String {
        "Apply copyright, \(keywordCount) keyword(s), and rating to \(itemCount) item(s)?"
    }
}

#Preview("MuiBatchMetadataModal") {
    struct Demo: View {
        @State private var open = false
        @State private var copyright = "© Just Maple"
        @State private var keywords = ["Iceland", "Glacier"]
        @State private var rating = 4
        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiButton(label: "Open Batch Metadata", variant: .primary) { open = true }
                MuiBatchMetadataModal(
                    isPresented: open, itemCount: 12,
                    copyright: $copyright, keywords: $keywords, rating: $rating,
                    dismissed: { open = false }
                )
            }
            .frame(width: 420, height: 360)
        }
    }
    return Demo()
}
