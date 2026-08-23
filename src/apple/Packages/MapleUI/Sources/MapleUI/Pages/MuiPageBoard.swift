// MuiPageBoard.swift — Maple UI Pages (unified-component-catalog.md §6).
// App Shell hosting a single Kanban Board organism — Maple's photo-culling
// board (To Cull → Picked → Final Selects).
//
// Kanban Board already does the hard part itself: it keeps its own
// `workingColumns` copy so a drag renders immediately, computes the moved
// card's new position with its own tested `moveResult`, and hands the page
// a `MuiKanbanMoveEvent` describing what happened. This page's only job —
// and the one thing that would silently regress without it — is applying
// that event back onto its own source-of-truth `columns`, so a card
// dropped in one render still shows up in the right column after any
// state that depends on `columns` (not `workingColumns`) recomputes. That
// re-application reuses Kanban Board's own already-tested `moveResult`,
// so there's no new pure-logic surface to add a test for here.

import SwiftUI

public struct MuiPageBoard: View {
    @State private var columns: [MuiKanbanColumn]

    public init(columns: [MuiKanbanColumn] = MuiPageBoard.defaultColumns) {
        self._columns = State(initialValue: columns)
    }

    public var body: some View {
        MuiAppShell {
            EmptyView()
        } content: {
            MuiKanbanBoard(columns: columns, moved: applyMove)
        }
        .background(MuiTokens.bg)
    }

    private func applyMove(_ event: MuiKanbanMoveEvent) {
        guard let result = MuiKanbanBoard.moveResult(
            columns: columns, cardId: event.cardId, fromColumnId: event.fromColumnId, toColumnId: event.toColumnId
        ) else { return }
        columns = result.columns
    }

    // MARK: - Default mock data

    public static let defaultColumns: [MuiKanbanColumn] = [
        MuiKanbanColumn(id: "todo", title: "To Cull", cards: [
            MuiKanbanCard(id: "1", title: "IMG_0401.dng", subtitle: "Iceland", badgeLabel: "RAW"),
            MuiKanbanCard(id: "2", title: "IMG_0402.dng", subtitle: "Iceland", badgeLabel: "RAW"),
            MuiKanbanCard(id: "3", title: "IMG_0417.dng", subtitle: "Iceland", badgeLabel: "RAW"),
        ]),
        MuiKanbanColumn(id: "picked", title: "Picked", cards: [
            MuiKanbanCard(id: "4", title: "IMG_0512.dng", subtitle: "Faroe Islands"),
        ]),
        MuiKanbanColumn(id: "final", title: "Final Selects", cards: []),
    ]
}

#Preview("MuiPageBoard") {
    MuiPageBoard()
        .frame(width: 700, height: 420)
}
