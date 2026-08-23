// MuiPageBrowse.swift — Maple UI Pages (unified-component-catalog.md §6).
// Split Layout hosting Sidebar, Collection Grid, Timeline, Map Surface, and
// a Toolbar. This is the Browse mode of the shell: a source tree on the
// left filters one shared asset pool, and a Toolbar in the center switches
// which of the three collection views (grid / timeline / map) renders that
// filtered pool — same "one dataset, three lenses" shape as the web
// reference's Browse route.
//
// Cross-organism wiring that's genuinely new at this tier (not already
// covered by an organism's own tests): filtering the shared asset pool by
// the active sidebar source, and re-grouping that filtered pool into
// timeline buckets. Both are pure static functions on `MuiPageBrowseAssets`
// below so they're unit-testable without a live view.

import SwiftUI

/// One photo in the Browse page's shared mock library — a Collection Grid
/// item plus the extra facets (source, date bucket, map position) that
/// drive the other two views. Held as its own type rather than widening
/// `MuiCollectionItem` itself, since those extra facets are Browse-page
/// concerns, not Collection Grid ones.
public struct MuiPageBrowseAsset: Identifiable, Sendable {
    public let id: String
    public let sourceId: String
    public let dateGroupId: String
    public let dateGroupLabel: String
    public var item: MuiCollectionItem
    public let geo: MuiMapSurfaceAnnotation?

    public init(
        id: String,
        sourceId: String,
        dateGroupId: String,
        dateGroupLabel: String,
        item: MuiCollectionItem,
        geo: MuiMapSurfaceAnnotation? = nil
    ) {
        self.id = id
        self.sourceId = sourceId
        self.dateGroupId = dateGroupId
        self.dateGroupLabel = dateGroupLabel
        self.item = item
        self.geo = geo
    }
}

public enum MuiPageBrowseViewMode: Sendable {
    case grid, timeline, map
}

public struct MuiPageBrowse: View {
    public static let allSourcesId = "all"

    public let sections: [MuiSidebarSection]
    public let assets: [MuiPageBrowseAsset]

    @State private var activeSourceId: String? = MuiPageBrowse.allSourcesId
    @State private var expandedIds: [String] = ["trips"]
    @State private var viewMode: MuiPageBrowseViewMode = .grid
    @State private var selectedIds: [String] = []
    @State private var activeTimelineFilterId: String? = "all"
    @State private var heatmapVisible = false
    @State private var workingAssets: [MuiPageBrowseAsset]

    public init(
        sections: [MuiSidebarSection] = MuiPageBrowse.defaultSections,
        assets: [MuiPageBrowseAsset] = MuiPageBrowse.defaultAssets
    ) {
        self.sections = sections
        self.assets = assets
        self._workingAssets = State(initialValue: assets)
    }

    private static let toolbarEntries: [MuiToolbarEntry] = [
        .item(MuiToolbarActionItem(id: "view-grid", icon: "square.grid.2x2", label: "Grid")),
        .item(MuiToolbarActionItem(id: "view-timeline", icon: "calendar", label: "Timeline")),
        .item(MuiToolbarActionItem(id: "view-map", icon: "map", label: "Map")),
        .divider,
        .item(MuiToolbarActionItem(id: "import", icon: "square.and.arrow.down", label: "Import")),
    ]

    private var filteredAssets: [MuiPageBrowseAsset] {
        Self.filteredAssets(workingAssets, activeSourceId: activeSourceId)
    }

    public var body: some View {
        MuiSplitLayout(showDetail: false) {
            MuiSidebar(
                sections: sections,
                toolbarEntries: [.item(MuiToolbarActionItem(id: "add-source", icon: "plus", label: "Add source"))],
                activeId: $activeSourceId,
                expandedIds: $expandedIds
            )
        } center: {
            VStack(spacing: 0) {
                MuiToolbar(entries: Self.toolbarEntries, itemSelected: handleToolbarAction)
                    .padding(MuiTokens.spacingSm)
                MuiDivider()
                content
            }
        }
        .background(MuiTokens.bg)
    }

    @ViewBuilder
    private var content: some View {
        switch viewMode {
        case .grid:
            MuiCollectionGrid(
                items: filteredAssets.map(\.item),
                columns: 5,
                selectedIds: $selectedIds,
                ratingChanged: { id, value in applyRating(id: id, rating: value) },
                flagChanged: { id, value in applyFlag(id: id, flag: value) }
            )
        case .timeline:
            MuiTimeline(
                groups: Self.timelineGroups(from: filteredAssets),
                filters: [MuiChip(id: "all", label: "All"), MuiChip(id: "raw", label: "RAW only")],
                columns: 5,
                activeFilterId: $activeTimelineFilterId,
                selectedIds: $selectedIds
            )
        case .map:
            MuiMapSurface(
                annotations: filteredAssets.compactMap(\.geo),
                heatmapVisible: $heatmapVisible
            )
        }
    }

    private func handleToolbarAction(_ id: String) {
        switch id {
        case "view-grid": viewMode = .grid
        case "view-timeline": viewMode = .timeline
        case "view-map": viewMode = .map
        default: break
        }
    }

    private func applyRating(id: String, rating: Int) {
        guard let idx = workingAssets.firstIndex(where: { $0.id == id }) else { return }
        workingAssets[idx].item.rating = rating
    }

    private func applyFlag(id: String, flag: MuiRatingFlagState) {
        guard let idx = workingAssets.firstIndex(where: { $0.id == id }) else { return }
        workingAssets[idx].item.flag = flag
    }

    // MARK: - Pure wiring logic (unit-testable without a live view)

    /// The assets visible for the active sidebar source — everything when
    /// no source (or the synthetic "all") is selected, otherwise only
    /// assets tagged with that exact source id.
    public static func filteredAssets(_ assets: [MuiPageBrowseAsset], activeSourceId: String?) -> [MuiPageBrowseAsset] {
        guard let activeSourceId, activeSourceId != allSourcesId else { return assets }
        return assets.filter { $0.sourceId == activeSourceId }
    }

    /// Buckets `assets` into `MuiTimelineGroup`s keyed by `dateGroupId`,
    /// preserving each bucket's first-seen order (not sorted alphabetically)
    /// so callers control chronological order simply by how they order the
    /// input array.
    public static func timelineGroups(from assets: [MuiPageBrowseAsset]) -> [MuiTimelineGroup] {
        var order: [String] = []
        var labels: [String: String] = [:]
        var itemsByGroup: [String: [MuiCollectionItem]] = [:]
        for asset in assets {
            if itemsByGroup[asset.dateGroupId] == nil {
                order.append(asset.dateGroupId)
                labels[asset.dateGroupId] = asset.dateGroupLabel
            }
            itemsByGroup[asset.dateGroupId, default: []].append(asset.item)
        }
        return order.map { groupId in
            MuiTimelineGroup(id: groupId, label: labels[groupId] ?? groupId, items: itemsByGroup[groupId] ?? [])
        }
    }

    // MARK: - Default mock data

    public static let defaultSections: [MuiSidebarSection] = [
        MuiSidebarSection(id: "cloud", label: "MAPLE CLOUD", nodes: [
            MuiSidebarNode(id: "trips", label: "2026 Trips", icon: "folder", children: [
                MuiSidebarNode(id: "iceland", label: "Iceland", icon: "photo", count: 4),
                MuiSidebarNode(id: "faroe", label: "Faroe Islands", icon: "photo", count: 3),
            ]),
        ]),
        MuiSidebarSection(id: "local", label: "LOCAL", nodes: [
            MuiSidebarNode(id: "desktop", label: "Desktop Import", icon: "externaldrive", count: 2),
        ]),
    ]

    public static let defaultAssets: [MuiPageBrowseAsset] = [
        MuiPageBrowseAsset(
            id: "1", sourceId: "iceland", dateGroupId: "mar-2026", dateGroupLabel: "March 2026",
            item: MuiCollectionItem(id: "1", url: nil, alt: "Glacier lagoon at dawn", filename: "IMG_0401.dng", badges: ["RAW"], rating: 4),
            geo: MuiMapSurfaceAnnotation(id: "1", x: 0.22, y: 0.28, label: "Jökulsárlón")
        ),
        MuiPageBrowseAsset(
            id: "2", sourceId: "iceland", dateGroupId: "mar-2026", dateGroupLabel: "March 2026",
            item: MuiCollectionItem(id: "2", url: nil, alt: "Basalt sea stacks", filename: "IMG_0402.dng", badges: ["RAW"]),
            geo: MuiMapSurfaceAnnotation(id: "2", x: 0.23, y: 0.29, label: "Reynisfjara")
        ),
        MuiPageBrowseAsset(
            id: "3", sourceId: "iceland", dateGroupId: "mar-2026", dateGroupLabel: "March 2026",
            item: MuiCollectionItem(id: "3", url: nil, alt: "Northern lights over a farmhouse", filename: "IMG_0417.dng", badges: ["RAW"], rating: 5, flag: .pick),
            geo: MuiMapSurfaceAnnotation(id: "3", x: 0.24, y: 0.27)
        ),
        MuiPageBrowseAsset(
            id: "4", sourceId: "iceland", dateGroupId: "apr-2026", dateGroupLabel: "April 2026",
            item: MuiCollectionItem(id: "4", url: nil, alt: "Black-sand beach panorama", filename: "IMG_0455.dng"),
            geo: MuiMapSurfaceAnnotation(id: "4", x: 0.21, y: 0.30)
        ),
        MuiPageBrowseAsset(
            id: "5", sourceId: "faroe", dateGroupId: "apr-2026", dateGroupLabel: "April 2026",
            item: MuiCollectionItem(id: "5", url: nil, alt: "Sheep on a green cliff", filename: "IMG_0512.dng", badges: ["RAW"]),
            geo: MuiMapSurfaceAnnotation(id: "5", x: 0.19, y: 0.24)
        ),
        MuiPageBrowseAsset(
            id: "6", sourceId: "faroe", dateGroupId: "apr-2026", dateGroupLabel: "April 2026",
            item: MuiCollectionItem(id: "6", url: nil, alt: "Village below a waterfall", filename: "IMG_0518.dng", rating: 3),
            geo: MuiMapSurfaceAnnotation(id: "6", x: 0.20, y: 0.25)
        ),
        MuiPageBrowseAsset(
            id: "7", sourceId: "faroe", dateGroupId: "may-2026", dateGroupLabel: "May 2026",
            item: MuiCollectionItem(id: "7", url: nil, alt: "Fog rolling over fjords", filename: "IMG_0540.dng", badges: ["RAW"])
        ),
        MuiPageBrowseAsset(
            id: "8", sourceId: "desktop", dateGroupId: "may-2026", dateGroupLabel: "May 2026",
            item: MuiCollectionItem(id: "8", url: nil, alt: "Studio product test shot", filename: "DSC_9001.jpg")
        ),
        MuiPageBrowseAsset(
            id: "9", sourceId: "desktop", dateGroupId: "jun-2026", dateGroupLabel: "June 2026",
            item: MuiCollectionItem(id: "9", url: nil, alt: "Backyard portrait session", filename: "DSC_9032.jpg", flag: .reject)
        ),
    ]
}

#Preview("MuiPageBrowse") {
    MuiPageBrowse()
        .frame(width: 900, height: 560)
}
