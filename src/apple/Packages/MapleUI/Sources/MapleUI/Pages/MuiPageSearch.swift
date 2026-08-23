// MuiPageSearch.swift — Maple UI Pages (unified-component-catalog.md §6).
// App Shell hosting a single Search organism.
//
// Search already owns its own query/suggestions/filter-panel-visibility
// wiring (tested at the organism tier); what it does NOT own is turning
// that query and those filter chips into an actual result set — Search
// takes `results` as a plain one-way input. That's the genuinely new
// cross-organism glue at this tier: `MuiPageSearch.filteredResults` runs
// the mock corpus through the live query text and whichever filter chips
// are active, so typing and toggling filters visibly narrows the grid.

import SwiftUI

public struct MuiPageSearchAsset: Identifiable, Sendable {
    public let id: String
    public let item: MuiCollectionItem
    public let keywords: [String]
    public let fileType: String

    public init(id: String, item: MuiCollectionItem, keywords: [String], fileType: String) {
        self.id = id
        self.item = item
        self.keywords = keywords
        self.fileType = fileType
    }
}

public struct MuiPageSearch: View {
    public let corpus: [MuiPageSearchAsset]

    @State private var query = "iceland"
    @State private var suggestionsOpen = false
    @State private var checkedOptionIds: Set<String> = []
    @State private var resultSelectedIds: [String] = []
    @State private var showFilters = false

    public init(corpus: [MuiPageSearchAsset] = MuiPageSearch.defaultCorpus) {
        self.corpus = corpus
    }

    private static let suggestions: [MuiSuggestionItem] = [
        MuiSuggestionItem(id: "iceland-waterfalls", label: "iceland waterfalls"),
        MuiSuggestionItem(id: "faroe-fog", label: "faroe fog"),
    ]

    private var filterGroups: [MuiFilterGroup] {
        [
            MuiFilterGroup(id: "type", label: "File Type", options: [
                MuiFilterOption(id: "raw", label: "RAW", checked: checkedOptionIds.contains("raw")),
                MuiFilterOption(id: "jpg", label: "JPEG", checked: checkedOptionIds.contains("jpg")),
            ]),
        ]
    }

    private var activeChips: [MuiChip] {
        checkedOptionIds.sorted().map { MuiChip(id: $0, label: $0 == "raw" ? "RAW" : "JPEG") }
    }

    private var results: [MuiCollectionItem] {
        Self.filteredResults(corpus, query: query, activeFileTypeIds: checkedOptionIds).map(\.item)
    }

    public var body: some View {
        MuiAppShell {
            EmptyView()
        } content: {
            MuiSearch(
                query: $query,
                suggestions: Self.suggestions,
                suggestionsOpen: $suggestionsOpen,
                filterGroups: filterGroups,
                activeChips: activeChips,
                results: results,
                totalCount: results.count,
                page: 1,
                pageCount: max(1, Int((Double(results.count) / 12).rounded(.up))),
                resultSelectedIds: $resultSelectedIds,
                showFilters: $showFilters,
                chipRemoved: { checkedOptionIds.remove($0) },
                filterOptionToggled: { _, optionId, checked in toggleOption(optionId, checked: checked) }
            )
        }
        .background(MuiTokens.bg)
    }

    private func toggleOption(_ optionId: String, checked: Bool) {
        if checked { checkedOptionIds.insert(optionId) } else { checkedOptionIds.remove(optionId) }
    }

    // MARK: - Pure wiring logic (unit-testable without a live view)

    /// The corpus narrowed to assets whose keywords contain `query`
    /// (case-insensitive substring, matching any keyword) and — when any
    /// file-type filter is checked — whose `fileType` is one of the
    /// checked ids. An empty, whitespace-only query matches everything.
    public static func filteredResults(
        _ corpus: [MuiPageSearchAsset],
        query: String,
        activeFileTypeIds: Set<String>
    ) -> [MuiPageSearchAsset] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return corpus.filter { asset in
            let matchesQuery = trimmed.isEmpty || asset.keywords.contains { $0.lowercased().contains(trimmed) }
            let matchesType = activeFileTypeIds.isEmpty || activeFileTypeIds.contains(asset.fileType)
            return matchesQuery && matchesType
        }
    }

    // MARK: - Default mock data

    public static let defaultCorpus: [MuiPageSearchAsset] = [
        MuiPageSearchAsset(
            id: "1", item: MuiCollectionItem(id: "1", url: nil, alt: "Glacier lagoon at dawn", filename: "IMG_0401.dng", badges: ["RAW"], rating: 4),
            keywords: ["iceland", "glacier", "lagoon"], fileType: "raw"
        ),
        MuiPageSearchAsset(
            id: "2", item: MuiCollectionItem(id: "2", url: nil, alt: "Basalt sea stacks", filename: "IMG_0402.dng", badges: ["RAW"]),
            keywords: ["iceland", "basalt", "coast"], fileType: "raw"
        ),
        MuiPageSearchAsset(
            id: "3", item: MuiCollectionItem(id: "3", url: nil, alt: "Fog over the fjords", filename: "IMG_0540.jpg"),
            keywords: ["faroe", "fog", "fjord"], fileType: "jpg"
        ),
        MuiPageSearchAsset(
            id: "4", item: MuiCollectionItem(id: "4", url: nil, alt: "Studio product test shot", filename: "DSC_9001.jpg"),
            keywords: ["studio", "product"], fileType: "jpg"
        ),
    ]
}

#Preview("MuiPageSearch") {
    MuiPageSearch()
        .frame(width: 700, height: 480)
}
