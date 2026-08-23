// MuiSearchResults.swift — Maple UI Organisms · Collections
// (unified-component-catalog.md §4.1). Paginated result grid with states,
// built from Collection Grid, Empty State, Progress.

import SwiftUI

public struct MuiSearchResults: View {
    public let items: [MuiCollectionItem]
    public let loading: Bool
    public let query: String
    public let totalCount: Int
    public let page: Int
    public let pageCount: Int
    public let columns: Int
    @Binding public var selectedIds: [String]
    public let opened: ((String) -> Void)?
    public let pageChanged: ((Int) -> Void)?

    public init(
        items: [MuiCollectionItem],
        loading: Bool = false,
        query: String = "",
        totalCount: Int = 0,
        page: Int = 1,
        pageCount: Int = 1,
        columns: Int = 4,
        selectedIds: Binding<[String]> = .constant([]),
        opened: ((String) -> Void)? = nil,
        pageChanged: ((Int) -> Void)? = nil
    ) {
        self.items = items
        self.loading = loading
        self.query = query
        self.totalCount = totalCount
        self.page = page
        self.pageCount = pageCount
        self.columns = columns
        self._selectedIds = selectedIds
        self.opened = opened
        self.pageChanged = pageChanged
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            header

            if loading {
                MuiProgress(shape: .bar, label: "Searching…")
                    .padding(.horizontal, MuiTokens.spacingMd)
            } else if items.isEmpty {
                MuiEmptyState(
                    icon: "magnifyingglass",
                    title: "No results",
                    message: query.isEmpty ? "Try a different search." : "No matches for \u{201C}\(query)\u{201D}."
                )
            } else {
                MuiCollectionGrid(items: items, columns: columns, selectedIds: $selectedIds, opened: opened)
                pagination
            }
        }
    }

    private var header: some View {
        HStack {
            MuiText(query.isEmpty ? "\(totalCount) results" : "\(totalCount) results for \u{201C}\(query)\u{201D}", variant: .body, color: .muted)
            Spacer()
        }
        .padding(.horizontal, MuiTokens.spacingMd)
    }

    private var pagination: some View {
        HStack {
            MuiButton(label: "Previous", variant: .ghost, size: .sm, disabled: page <= 1) {
                pageChanged?(page - 1)
            }
            Spacer()
            MuiText("Page \(page) of \(pageCount)", variant: .body, color: .muted)
            Spacer()
            MuiButton(label: "Next", variant: .ghost, size: .sm, disabled: page >= pageCount) {
                pageChanged?(page + 1)
            }
        }
        .padding(.horizontal, MuiTokens.spacingMd)
        .padding(.bottom, MuiTokens.spacingSm)
    }
}

#Preview("MuiSearchResults — Populated") {
    struct Demo: View {
        @State private var selected: [String] = []
        var body: some View {
            MuiSearchResults(
                items: (1...8).map { MuiCollectionItem(id: "\($0)", url: nil, alt: "Result \($0)") },
                query: "iceland",
                totalCount: 42,
                page: 2,
                pageCount: 6,
                columns: 4,
                selectedIds: $selected
            )
            .frame(height: 420)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}

#Preview("MuiSearchResults — Loading / Empty") {
    VStack(spacing: 0) {
        MuiSearchResults(items: [], loading: true, query: "iceland").frame(height: 120)
        MuiDivider()
        MuiSearchResults(items: [], query: "zzzz").frame(height: 160)
    }
    .background(MuiTokens.bg)
}
