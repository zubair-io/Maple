// MuiTimeline.swift — Maple UI Organisms · Collections
// (unified-component-catalog.md §4.1). Date-grouped infinite scroll,
// built from Collection Grid, Text, Chip Row.
//
// Selection is global across the whole timeline, not per-group:
// `selectedIds` forwards into every nested Collection Grid's own
// `selectedIds` binding, so selecting a photo in March and shift-clicking
// one in April both write into the same flat id list. Each group gets its
// own grid (its own scroll region) rather than one grid spanning every
// group, so the sticky date header can sit between them in normal
// document flow — `Section` inside a `LazyVStack`-backed `ScrollView`
// gives pinned headers for free via `.pinnedViews`.

import SwiftUI

public struct MuiTimelineGroup: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let items: [MuiCollectionItem]

    public init(id: String, label: String, items: [MuiCollectionItem]) {
        self.id = id
        self.label = label
        self.items = items
    }
}

public struct MuiTimeline: View {
    public let groups: [MuiTimelineGroup]
    public let loading: Bool
    public let error: String?
    public let filters: [MuiChip]
    public let columns: Int
    @Binding public var activeFilterId: String?
    @Binding public var selectedIds: [String]
    public let opened: ((String) -> Void)?

    public init(
        groups: [MuiTimelineGroup],
        loading: Bool = false,
        error: String? = nil,
        filters: [MuiChip] = [],
        columns: Int = 6,
        activeFilterId: Binding<String?> = .constant(nil),
        selectedIds: Binding<[String]> = .constant([]),
        opened: ((String) -> Void)? = nil
    ) {
        self.groups = groups
        self.loading = loading
        self.error = error
        self.filters = filters
        self.columns = columns
        self._activeFilterId = activeFilterId
        self._selectedIds = selectedIds
        self.opened = opened
    }

    /// True when every group is present but holds no items — distinct
    /// from `groups.isEmpty` (no date buckets at all), both of which
    /// render the same "nothing here" empty state.
    private var allGroupsEmpty: Bool {
        groups.allSatisfy { $0.items.isEmpty }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !filters.isEmpty {
                MuiChipRow(chips: filters, mode: .select, selectedId: $activeFilterId)
                    .padding(.horizontal, MuiTokens.spacingMd)
                    .padding(.vertical, MuiTokens.spacingSm)
                MuiDivider()
            }

            if loading {
                MuiSpinner(placement: .centered, label: "Loading timeline")
            } else if let error {
                MuiEmptyState(icon: "exclamationmark.triangle", title: "Couldn't load timeline", message: error)
            } else if groups.isEmpty || allGroupsEmpty {
                MuiEmptyState(icon: "calendar", title: "No photos", message: "Nothing to show for this range.")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: MuiTokens.spacingLg, pinnedViews: [.sectionHeaders]) {
                        ForEach(groups) { group in
                            Section {
                                MuiCollectionGrid(
                                    items: group.items,
                                    columns: columns,
                                    selectedIds: $selectedIds,
                                    opened: opened
                                )
                                .frame(height: groupHeight(for: group))
                            } header: {
                                MuiText(group.label, variant: .eyebrow, color: .muted)
                                    .padding(.horizontal, MuiTokens.spacingMd)
                                    .padding(.vertical, MuiTokens.spacingXs)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(MuiTokens.bg)
                            }
                        }
                    }
                }
            }
        }
    }

    /// Row count for a group is clamped to `Self.maxVisibleRows` and
    /// floored at 1 so an empty group still has room to render its own
    /// empty state — same clamp the web reference applies before
    /// computing its per-group grid's pixel height.
    private func groupHeight(for group: MuiTimelineGroup) -> CGFloat {
        CGFloat(Self.visibleRows(itemCount: group.items.count, columns: columns)) * Self.cellHeight
    }

    // MARK: - Pure layout math (unit-testable without a live view)

    static let cellHeight: CGFloat = 160
    static let maxVisibleRows = 3

    public static func visibleRows(itemCount: Int, columns: Int) -> Int {
        guard columns > 0 else { return 1 }
        let rows = Int((Double(itemCount) / Double(columns)).rounded(.up))
        return max(1, min(maxVisibleRows, rows))
    }
}

#Preview("MuiTimeline — Populated") {
    struct Demo: View {
        @State private var selected: [String] = []
        @State private var filter: String? = "all"
        var body: some View {
            MuiTimeline(
                groups: [
                    MuiTimelineGroup(id: "mar", label: "March 2026", items: (1...5).map { MuiCollectionItem(id: "mar-\($0)", url: nil, alt: "Photo \($0)") }),
                    MuiTimelineGroup(id: "apr", label: "April 2026", items: (1...9).map { MuiCollectionItem(id: "apr-\($0)", url: nil, alt: "Photo \($0)") }),
                ],
                filters: [MuiChip(id: "all", label: "All"), MuiChip(id: "raw", label: "RAW only")],
                columns: 4,
                activeFilterId: $filter,
                selectedIds: $selected
            )
            .frame(height: 480)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}

#Preview("MuiTimeline — Loading / Empty / Error") {
    VStack(spacing: 0) {
        MuiTimeline(groups: [], loading: true).frame(height: 120)
        MuiDivider()
        MuiTimeline(groups: []).frame(height: 120)
        MuiDivider()
        MuiTimeline(groups: [], error: "Timed out fetching the timeline.").frame(height: 120)
    }
    .background(MuiTokens.bg)
}
