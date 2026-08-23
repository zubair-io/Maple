// MuiKanbanBoard.swift — Maple UI Organisms · Collections
// (unified-component-catalog.md §4.1). Drag-and-drop column board, built
// from Card, Text.
//
// Drag-and-drop needs immediate visual feedback while the caller still
// owns the real data, so this view keeps an internal `workingColumns`
// copy resynced from the `columns` input (via `.onChange`, mirroring the
// web reference's `effect()`) and renders that copy. A drop mutates the
// working copy functionally — no hit-testing between cards, a drop always
// appends to the end of the target column, per the organism spec — and
// fires `moved` so the caller can commit the same change to its own
// source of truth. The mutation itself is a pure static function
// (`moveResult`) so it's unit-testable without a live drag session.
//
// Deviation from the catalog's building-block list: the row cites Button
// alongside Card and Text, but nothing in this organism's behavior calls
// for one (no retry/add-card affordance was specified), so no Button.

import SwiftUI
import UniformTypeIdentifiers

public struct MuiKanbanCard: Identifiable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String?
    public let url: URL?
    public let badgeLabel: String?

    public init(id: String, title: String, subtitle: String? = nil, url: URL? = nil, badgeLabel: String? = nil) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.url = url
        self.badgeLabel = badgeLabel
    }
}

public struct MuiKanbanColumn: Identifiable, Sendable {
    public let id: String
    public let title: String
    public let cards: [MuiKanbanCard]

    public init(id: String, title: String, cards: [MuiKanbanCard]) {
        self.id = id
        self.title = title
        self.cards = cards
    }
}

public struct MuiKanbanMoveEvent: Equatable, Sendable {
    public let cardId: String
    public let fromColumnId: String
    public let toColumnId: String
    public let toIndex: Int
}

public struct MuiKanbanBoard: View {
    public let columns: [MuiKanbanColumn]
    public let loading: Bool
    public let error: String?
    public let emptyMessage: String
    public let moved: ((MuiKanbanMoveEvent) -> Void)?

    @State private var workingColumns: [MuiKanbanColumn] = []
    @State private var draggingCardId: String?
    @State private var draggingFromColumnId: String?

    public init(
        columns: [MuiKanbanColumn],
        loading: Bool = false,
        error: String? = nil,
        emptyMessage: String = "No cards yet.",
        moved: ((MuiKanbanMoveEvent) -> Void)? = nil
    ) {
        self.columns = columns
        self.loading = loading
        self.error = error
        self.emptyMessage = emptyMessage
        self.moved = moved
    }

    private var signature: String {
        columns.map { "\($0.id):\($0.cards.map(\.id).joined(separator: ","))" }.joined(separator: "|")
    }

    public var body: some View {
        Group {
            if loading {
                MuiSpinner(placement: .centered, label: "Loading board")
            } else if let error {
                MuiEmptyState(icon: "exclamationmark.triangle", title: "Couldn't load board", message: error)
            } else if columns.isEmpty || columns.allSatisfy({ $0.cards.isEmpty }) {
                MuiEmptyState(icon: "rectangle.stack", title: "No cards", message: emptyMessage)
            } else {
                board
            }
        }
        .onAppear { workingColumns = columns }
        .onChange(of: signature) { _, _ in workingColumns = columns }
    }

    private var board: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: MuiTokens.spacingMd) {
                ForEach(workingColumns) { column in
                    columnView(column)
                }
            }
            .padding(MuiTokens.spacingMd)
        }
    }

    private func columnView(_ column: MuiKanbanColumn) -> some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            HStack {
                MuiText(column.title, variant: .rowLabel)
                MuiBadge(variant: .count, value: "\(column.cards.count)")
            }
            VStack(spacing: MuiTokens.spacingSm) {
                ForEach(column.cards) { card in
                    MuiCard(url: card.url, alt: card.title, title: card.title, subtitle: card.subtitle, badgeLabel: card.badgeLabel)
                        .onDrag {
                            draggingCardId = card.id
                            draggingFromColumnId = column.id
                            return NSItemProvider(object: card.id as NSString)
                        }
                }
            }
        }
        .padding(MuiTokens.spacingSm)
        .frame(width: 220, alignment: .top)
        .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous))
        .onDrop(of: [.text], isTargeted: nil) { _ in
            drop(intoColumnId: column.id)
            return true
        }
    }

    private func drop(intoColumnId toColumnId: String) {
        defer {
            draggingCardId = nil
            draggingFromColumnId = nil
        }
        guard let cardId = draggingCardId, let fromColumnId = draggingFromColumnId,
              let result = Self.moveResult(columns: workingColumns, cardId: cardId, fromColumnId: fromColumnId, toColumnId: toColumnId)
        else { return }
        workingColumns = result.columns
        moved?(result.event)
    }

    // MARK: - Pure move logic (unit-testable without a live drag session)

    /// The board after moving `cardId` from `fromColumnId` to the end of
    /// `toColumnId`, plus the event describing that move — `nil` when the
    /// source column, card, or target column can't be resolved (a drop
    /// that raced a concurrent data change). No hit-testing between
    /// cards: a drop always appends to the target column's end, matching
    /// the organism spec.
    public static func moveResult(
        columns: [MuiKanbanColumn],
        cardId: String,
        fromColumnId: String,
        toColumnId: String
    ) -> (columns: [MuiKanbanColumn], event: MuiKanbanMoveEvent)? {
        guard let sourceColumn = columns.first(where: { $0.id == fromColumnId }),
              let card = sourceColumn.cards.first(where: { $0.id == cardId }),
              columns.contains(where: { $0.id == toColumnId })
        else { return nil }

        let toIndex = columns.first(where: { $0.id == toColumnId })?.cards.count ?? 0
        let next = columns.map { column -> MuiKanbanColumn in
            let withoutCard = column.id == fromColumnId
                ? MuiKanbanColumn(id: column.id, title: column.title, cards: column.cards.filter { $0.id != cardId })
                : column
            return withoutCard.id == toColumnId
                ? MuiKanbanColumn(id: withoutCard.id, title: withoutCard.title, cards: withoutCard.cards + [card])
                : withoutCard
        }
        return (next, MuiKanbanMoveEvent(cardId: cardId, fromColumnId: fromColumnId, toColumnId: toColumnId, toIndex: toIndex))
    }
}

#Preview("MuiKanbanBoard — Populated") {
    MuiKanbanBoard(columns: [
        MuiKanbanColumn(id: "todo", title: "To Cull", cards: [
            MuiKanbanCard(id: "1", title: "IMG_0042.dng", subtitle: "Iceland", badgeLabel: "RAW"),
            MuiKanbanCard(id: "2", title: "IMG_0043.dng", subtitle: "Iceland"),
        ]),
        MuiKanbanColumn(id: "picked", title: "Picked", cards: [
            MuiKanbanCard(id: "3", title: "IMG_0050.dng", subtitle: "Faroe Islands"),
        ]),
        MuiKanbanColumn(id: "final", title: "Final Selects", cards: []),
    ])
    .frame(height: 320)
    .background(MuiTokens.bg)
}

#Preview("MuiKanbanBoard — Loading / Empty / Error") {
    VStack(spacing: 0) {
        MuiKanbanBoard(columns: [], loading: true).frame(height: 100)
        MuiDivider()
        MuiKanbanBoard(columns: []).frame(height: 100)
        MuiDivider()
        MuiKanbanBoard(columns: [], error: "Couldn't load the board.").frame(height: 100)
    }
    .background(MuiTokens.bg)
}
