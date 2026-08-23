// MuiPageTVTimeline.swift — Maple UI Pages (unified-component-catalog.md
// §6). Tab Shell switching between Timeline (date-grouped) and Collection
// Grid (flat "All Photos") views of the same tvOS library — the "Rediscover
// shelf" style browse surface (see the tvOS timeline work in
// e2e233981/0b0f034fc).
//
// Cross-organism wiring that's genuinely new at this tier: Timeline is
// the single source of truth for the mock library (grouped by month);
// Collection Grid needs that same library flattened to one ordered list
// for its "All Photos" tab, so both tabs are always showing the same
// underlying set rather than two independently-seeded pools going stale
// against each other. `MuiPageTVTimeline.flattenedItems` is the pure
// translation behind that. Selection is a single shared binding across
// both tabs, so a pick made in one view stays picked after switching tabs.

import SwiftUI

public struct MuiPageTVTimeline: View {
    public let groups: [MuiTimelineGroup]

    @State private var activeTabId = "timeline"
    @State private var selectedIds: [String] = []
    @State private var activeFilterId: String? = "all"

    public init(groups: [MuiTimelineGroup] = MuiPageTVTimeline.defaultGroups) {
        self.groups = groups
    }

    private static let tabs: [MuiTab] = [
        MuiTab(id: "timeline", label: "Timeline", icon: "calendar"),
        MuiTab(id: "grid", label: "All Photos", icon: "square.grid.2x2"),
    ]

    public var body: some View {
        MuiTabShell(tabs: Self.tabs, activeId: $activeTabId, accessibilityLabel: "Library view") {
            if activeTabId == "grid" {
                MuiCollectionGrid(items: Self.flattenedItems(from: groups), columns: 6, selectedIds: $selectedIds)
            } else {
                MuiTimeline(
                    groups: groups,
                    filters: [MuiChip(id: "all", label: "All"), MuiChip(id: "raw", label: "RAW only")],
                    columns: 6,
                    activeFilterId: $activeFilterId,
                    selectedIds: $selectedIds
                )
            }
        }
        .background(MuiTokens.bg)
    }

    // MARK: - Pure wiring logic (unit-testable without a live view)

    /// Every item across every group, in group order then item order — the
    /// flat list Collection Grid's "All Photos" tab needs from the same
    /// grouped data Timeline renders, so the two tabs never drift apart
    /// into separately-maintained mock pools.
    public static func flattenedItems(from groups: [MuiTimelineGroup]) -> [MuiCollectionItem] {
        groups.flatMap(\.items)
    }

    // MARK: - Default mock data

    public static let defaultGroups: [MuiTimelineGroup] = [
        MuiTimelineGroup(id: "mar-2026", label: "March 2026", items: [
            MuiCollectionItem(id: "1", url: nil, alt: "Glacier lagoon at dawn", filename: "IMG_0401.dng", badges: ["RAW"], rating: 4),
            MuiCollectionItem(id: "2", url: nil, alt: "Basalt sea stacks", filename: "IMG_0402.dng", badges: ["RAW"]),
        ]),
        MuiTimelineGroup(id: "apr-2026", label: "April 2026", items: [
            MuiCollectionItem(id: "3", url: nil, alt: "Sheep on a green cliff", filename: "IMG_0512.dng", badges: ["RAW"]),
            MuiCollectionItem(id: "4", url: nil, alt: "Village below a waterfall", filename: "IMG_0518.dng", rating: 3),
            MuiCollectionItem(id: "5", url: nil, alt: "Fog rolling over fjords", filename: "IMG_0540.dng", badges: ["RAW"]),
        ]),
    ]
}

#Preview("MuiPageTVTimeline") {
    MuiPageTVTimeline()
        .frame(width: 900, height: 500)
}
