// MuiPageTVMap.swift — Maple UI Pages (unified-component-catalog.md §6).
// Tab Shell switching Map Surface between "All Locations" and "Favorites"
// — the tvOS map browse surface, remote-navigable via the two tabs rather
// than a Filter Panel (which needs a keyboard-ish free-text search this
// page's 10-foot UI doesn't have room for).
//
// Cross-organism wiring that's genuinely new at this tier: which pins Map
// Surface shows is derived from the active tab, not passed in directly —
// `MuiPageTVMap.annotations(for:in:)` is the pure filter behind that.

import SwiftUI

/// One geotagged photo in the TV Map page's mock library — a Map Surface
/// annotation plus the favorite flag the "Favorites" tab filters on.
public struct MuiPageTVMapAsset: Identifiable, Sendable {
    public let id: String
    public let annotation: MuiMapSurfaceAnnotation
    public let favorite: Bool

    public init(id: String, annotation: MuiMapSurfaceAnnotation, favorite: Bool = false) {
        self.id = id
        self.annotation = annotation
        self.favorite = favorite
    }
}

public struct MuiPageTVMap: View {
    public let assets: [MuiPageTVMapAsset]

    @State private var activeTabId = "all"
    @State private var heatmapVisible = false

    public init(assets: [MuiPageTVMapAsset] = MuiPageTVMap.defaultAssets) {
        self.assets = assets
    }

    private static let tabs: [MuiTab] = [
        MuiTab(id: "all", label: "All Locations", icon: "map"),
        MuiTab(id: "favorites", label: "Favorites", icon: "star"),
    ]

    public var body: some View {
        MuiTabShell(tabs: Self.tabs, activeId: $activeTabId, accessibilityLabel: "Map filter") {
            MuiMapSurface(annotations: Self.annotations(for: activeTabId, in: assets), heatmapVisible: $heatmapVisible)
        }
        .background(MuiTokens.bg)
    }

    // MARK: - Pure wiring logic (unit-testable without a live view)

    /// The pins Map Surface should show for the active tab — every asset's
    /// annotation for `"all"`, only the favorited ones for `"favorites"`
    /// (or any other tab id, so an unrecognized id fails closed to the
    /// narrower set rather than silently showing everything).
    public static func annotations(for tabId: String, in assets: [MuiPageTVMapAsset]) -> [MuiMapSurfaceAnnotation] {
        let visible = tabId == "all" ? assets : assets.filter(\.favorite)
        return visible.map(\.annotation)
    }

    // MARK: - Default mock data

    public static let defaultAssets: [MuiPageTVMapAsset] = [
        MuiPageTVMapAsset(id: "1", annotation: MuiMapSurfaceAnnotation(id: "1", x: 0.22, y: 0.28, label: "Jökulsárlón"), favorite: true),
        MuiPageTVMapAsset(id: "2", annotation: MuiMapSurfaceAnnotation(id: "2", x: 0.23, y: 0.29, label: "Reynisfjara")),
        MuiPageTVMapAsset(id: "3", annotation: MuiMapSurfaceAnnotation(id: "3", x: 0.24, y: 0.27, label: "Vík"), favorite: true),
        MuiPageTVMapAsset(id: "4", annotation: MuiMapSurfaceAnnotation(id: "4", x: 0.19, y: 0.24, label: "Tórshavn")),
    ]
}

#Preview("MuiPageTVMap") {
    MuiPageTVMap()
        .frame(width: 700, height: 460)
}
