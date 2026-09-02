// OrganismsCollectionsGallery.swift — Organisms §4.1 (Collections): 6
// specimen cards — Collection Grid, List View, Timeline, Kanban Board,
// Filmstrip, Search Results. See OrganismsGallerySection.swift for the
// tab this feeds into.

import SwiftUI

struct OrganismsCollectionsGallery: View {
    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            collectionGridCard
            listViewCard
            timelineCard
            kanbanBoardCard
            filmstripCard
            searchResultsCard
        }
    }

    private var collectionGridCard: some View {
        GallerySpecimenCard(name: "Collection Grid", purpose: "Virtualized selectable thumbnail grid", builtFrom: "Media Cell, Empty State, Spinner, Drag Preview") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                CollectionGridDemo()
                OrganismStatesRow(
                    loading: { MuiCollectionGrid(items: [], loading: true).frame(height: 60) },
                    empty: { MuiCollectionGrid(items: []).frame(height: 60) },
                    error: { MuiCollectionGrid(items: [], error: "Network share unreachable.").frame(height: 60) }
                )
            }
        }
    }

    private var listViewCard: some View {
        GallerySpecimenCard(name: "List View", purpose: "Virtualized row list", builtFrom: "List Row, Empty State, Spinner") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                ListViewDemo()
                OrganismStatesRow(
                    loading: { MuiListView(items: [], loading: true).frame(height: 60) },
                    empty: { MuiListView(items: []).frame(height: 60) },
                    error: { MuiListView(items: [], error: "Couldn't reach the server.").frame(height: 60) }
                )
            }
        }
    }

    private var timelineCard: some View {
        GallerySpecimenCard(name: "Timeline", purpose: "Date-grouped infinite scroll", builtFrom: "Collection Grid, Text, Chip Row") {
            TimelineDemo()
        }
    }

    private var kanbanBoardCard: some View {
        GallerySpecimenCard(name: "Kanban Board", purpose: "Drag-and-drop column board", builtFrom: "Card, Text") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                KanbanBoardDemo()
                OrganismStatesRow(
                    loading: { MuiKanbanBoard(columns: [], loading: true).frame(height: 60) },
                    empty: { MuiKanbanBoard(columns: []).frame(height: 60) },
                    error: { MuiKanbanBoard(columns: [], error: "Couldn't load the board.").frame(height: 60) }
                )
            }
        }
    }

    private var filmstripCard: some View {
        GallerySpecimenCard(name: "Filmstrip", purpose: "Focus-following thumbnail strip", builtFrom: "Filmstrip Row, Filmstrip Rail") {
            FilmstripDemo()
        }
    }

    // The demo and its Loading/Empty states used to sit side by side in an
    // HStack with the states pinned to a fixed 160pt width (#3062) — on an
    // iPhone-width card that was wide enough on its own to force
    // `GallerySpecimenCard`'s new scroll fallback (see that file), and the
    // states' fixed 80pt height was too short for their header text plus
    // body content, so the Loading and Empty labels overlapped. Stacking
    // the demo above a states row that — like the shared
    // `OrganismStatesRow` every other card in this file uses — sizes each
    // box with `maxWidth: .infinity` and a taller minimum height fixes the
    // overlap and, as a bonus, comfortably fits without needing the scroll
    // fallback at all.
    private var searchResultsCard: some View {
        GallerySpecimenCard(name: "Search Results", purpose: "Paginated result grid with states", builtFrom: "Collection Grid, Empty State, Progress") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                SearchResultsDemo()
                HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
                    stateBox("Loading") { MuiSearchResults(items: [], loading: true, query: "iceland") }
                    stateBox("Empty") { MuiSearchResults(items: [], query: "zzzz") }
                }
            }
        }
    }

    private func stateBox(_ label: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            MuiText(label, variant: .toolLabel, color: .muted)
            content()
                .frame(maxWidth: .infinity, minHeight: 120, alignment: .top)
                .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
        }
        .frame(maxWidth: .infinity)
    }
}

private struct CollectionGridDemo: View {
    @State private var selected: [String] = ["2"]
    var body: some View {
        MuiCollectionGrid(
            items: (1...8).map { MuiCollectionItem(id: "\($0)", url: nil, alt: "Photo \($0)", filename: "IMG_00\($0).dng") },
            columns: 4,
            selectedIds: $selected
        )
        .frame(height: 220)
    }
}

private struct ListViewDemo: View {
    @State private var active: String? = "2"
    var body: some View {
        MuiListView(
            items: [
                MuiListViewItem(id: "1", icon: "doc", label: "Export batch.json", subtitle: "42 photos"),
                MuiListViewItem(id: "2", icon: "photo", label: "IMG_0042.dng", timestampValue: Date().addingTimeInterval(-3600)),
                MuiListViewItem(id: "3", icon: "folder", label: "2026 Iceland Trip", subtitle: "214 items"),
            ],
            activeId: $active
        )
        .frame(height: 160)
    }
}

private struct TimelineDemo: View {
    @State private var selected: [String] = []
    @State private var filter: String? = "all"
    var body: some View {
        MuiTimeline(
            groups: [
                MuiTimelineGroup(id: "mar", label: "March 2026", items: (1...4).map { MuiCollectionItem(id: "mar-\($0)", url: nil, alt: "Photo \($0)") }),
                MuiTimelineGroup(id: "apr", label: "April 2026", items: (1...8).map { MuiCollectionItem(id: "apr-\($0)", url: nil, alt: "Photo \($0)") }),
            ],
            filters: [MuiChip(id: "all", label: "All"), MuiChip(id: "raw", label: "RAW only")],
            columns: 4,
            activeFilterId: $filter,
            selectedIds: $selected
        )
        .frame(height: 320)
    }
}

private struct KanbanBoardDemo: View {
    var body: some View {
        MuiKanbanBoard(columns: [
            MuiKanbanColumn(id: "todo", title: "To Cull", cards: [
                MuiKanbanCard(id: "1", title: "IMG_0042.dng", subtitle: "Iceland", badgeLabel: "RAW"),
                MuiKanbanCard(id: "2", title: "IMG_0043.dng", subtitle: "Iceland"),
            ]),
            MuiKanbanColumn(id: "picked", title: "Picked", cards: [MuiKanbanCard(id: "3", title: "IMG_0050.dng")]),
            MuiKanbanColumn(id: "final", title: "Final Selects", cards: []),
        ])
        .frame(height: 220)
    }
}

private struct FilmstripDemo: View {
    @State private var active: String? = "2"
    var body: some View {
        MuiFilmstrip(
            items: (1...8).map { MuiFilmstripItem(id: "\($0)", url: nil, alt: "Frame \($0)") },
            activeId: $active
        )
        .frame(height: 100)
    }
}

private struct SearchResultsDemo: View {
    @State private var selected: [String] = []
    var body: some View {
        MuiSearchResults(
            items: (1...6).map { MuiCollectionItem(id: "\($0)", url: nil, alt: "Result \($0)") },
            query: "iceland",
            totalCount: 42,
            page: 2,
            pageCount: 6,
            columns: 4,
            selectedIds: $selected
        )
        .frame(height: 240)
    }
}
