// MuiSearch.swift — Maple UI Organisms · Navigation
// (unified-component-catalog.md §4.2). Query, filters, and results
// composed together: a search bar with an inline suggestion popover, an
// applied-filter chip row, a togglable Filter Panel, and the paginated
// Search Results grid. Built from Search Bar, Chip Row, Suggestion Menu,
// Search Results, Filter Panel.
//
// Purely presentational — the caller owns the query, suggestions,
// filters, and results via inputs/bindings; the Filter Panel's visibility
// is the only state this view keeps for itself. Search Results already
// owns its own loading/empty presentation, so there's nothing extra to
// handle at this level.

import SwiftUI

public struct MuiSearch: View {
    @Binding public var query: String
    public let suggestions: [MuiSuggestionItem]
    @Binding public var suggestionsOpen: Bool
    public let filterGroups: [MuiFilterGroup]
    public let activeChips: [MuiChip]
    public let results: [MuiCollectionItem]
    public let resultsLoading: Bool
    public let totalCount: Int
    public let page: Int
    public let pageCount: Int
    @Binding public var resultSelectedIds: [String]
    @Binding public var showFilters: Bool
    public let committed: ((String) -> Void)?
    public let suggestionSelected: ((String) -> Void)?
    public let chipRemoved: ((String) -> Void)?
    public let filterOptionToggled: ((String, String, Bool) -> Void)?
    public let opened: ((String) -> Void)?
    public let pageChanged: ((Int) -> Void)?

    public init(
        query: Binding<String>,
        suggestions: [MuiSuggestionItem] = [],
        suggestionsOpen: Binding<Bool> = .constant(false),
        filterGroups: [MuiFilterGroup] = [],
        activeChips: [MuiChip] = [],
        results: [MuiCollectionItem],
        resultsLoading: Bool = false,
        totalCount: Int = 0,
        page: Int = 1,
        pageCount: Int = 1,
        resultSelectedIds: Binding<[String]> = .constant([]),
        showFilters: Binding<Bool> = .constant(false),
        committed: ((String) -> Void)? = nil,
        suggestionSelected: ((String) -> Void)? = nil,
        chipRemoved: ((String) -> Void)? = nil,
        filterOptionToggled: ((String, String, Bool) -> Void)? = nil,
        opened: ((String) -> Void)? = nil,
        pageChanged: ((Int) -> Void)? = nil
    ) {
        self._query = query
        self.suggestions = suggestions
        self._suggestionsOpen = suggestionsOpen
        self.filterGroups = filterGroups
        self.activeChips = activeChips
        self.results = results
        self.resultsLoading = resultsLoading
        self.totalCount = totalCount
        self.page = page
        self.pageCount = pageCount
        self._resultSelectedIds = resultSelectedIds
        self._showFilters = showFilters
        self.committed = committed
        self.suggestionSelected = suggestionSelected
        self.chipRemoved = chipRemoved
        self.filterOptionToggled = filterOptionToggled
        self.opened = opened
        self.pageChanged = pageChanged
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MuiSuggestionMenu(open: $suggestionsOpen, items: suggestions, select: { suggestionSelected?($0) }) {
                MuiSearchBar(
                    value: $query,
                    actionLabel: "Filters",
                    actionIcon: "line.3.horizontal.decrease.circle",
                    committed: { committed?(query) },
                    actionPressed: { showFilters.toggle() }
                )
            }
            .padding(MuiTokens.spacingMd)

            if !activeChips.isEmpty {
                MuiChipRow(chips: activeChips, mode: .removable, removed: { chipRemoved?($0) })
                    .padding(.horizontal, MuiTokens.spacingMd)
                    .padding(.bottom, MuiTokens.spacingSm)
            }

            HStack(alignment: .top, spacing: 0) {
                if showFilters {
                    MuiFilterPanel(
                        groups: filterGroups,
                        optionToggled: { groupId, optionId, checked in filterOptionToggled?(groupId, optionId, checked) }
                    )
                    .frame(width: 220)
                    MuiDivider(orientation: .vertical)
                }

                MuiSearchResults(
                    items: results,
                    loading: resultsLoading,
                    query: query,
                    totalCount: totalCount,
                    page: page,
                    pageCount: pageCount,
                    selectedIds: $resultSelectedIds,
                    opened: opened,
                    pageChanged: pageChanged
                )
                .frame(maxWidth: .infinity)
            }
        }
    }
}

#Preview("MuiSearch — Populated") {
    struct Demo: View {
        @State private var query = "iceland"
        @State private var suggestionsOpen = false
        @State private var selected: [String] = []
        @State private var showFilters = true
        var body: some View {
            MuiSearch(
                query: $query,
                suggestions: [MuiSuggestionItem(id: "1", label: "iceland waterfalls")],
                suggestionsOpen: $suggestionsOpen,
                filterGroups: [MuiFilterGroup(id: "type", label: "File Type", options: [MuiFilterOption(id: "raw", label: "RAW", checked: true)])],
                activeChips: [MuiChip(id: "type:raw", label: "RAW")],
                results: (1...6).map { MuiCollectionItem(id: "\($0)", url: nil, alt: "Photo \($0)") },
                totalCount: 42,
                page: 1,
                pageCount: 7,
                resultSelectedIds: $selected,
                showFilters: $showFilters
            )
            .frame(height: 440)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
