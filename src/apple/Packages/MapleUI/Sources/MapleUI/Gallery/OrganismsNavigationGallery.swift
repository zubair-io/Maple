// OrganismsNavigationGallery.swift — Organisms §4.2 (Navigation): 4
// specimen cards — Sidebar, Tool Dock, Search, Filter Panel. See
// OrganismsGallerySection.swift for the tab this feeds into.

import SwiftUI

struct OrganismsNavigationGallery: View {
    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            sidebarCard
            toolDockCard
            searchCard
            filterPanelCard
        }
    }

    private var sidebarCard: some View {
        GallerySpecimenCard(name: "Sidebar", purpose: "Hierarchical source / page tree", builtFrom: "Tree Row, Toolbar, Collapsible, Context Menu, Empty State") {
            HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
                SidebarDemo()
                VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                    labeledBox("Loading") { MuiSidebar(sections: [], loading: true) }
                    labeledBox("Empty") { MuiSidebar(sections: []) }
                }
            }
        }
    }

    private func labeledBox(_ label: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            MuiText(label, variant: .toolLabel, color: .muted)
            content()
                .frame(width: 160, height: 76)
                .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
        }
    }

    private var toolDockCard: some View {
        GallerySpecimenCard(name: "Tool Dock", purpose: "Tool group switcher", builtFrom: "Action Button, Divider, Icon") {
            HStack(spacing: MuiTokens.spacingLg) {
                ToolDockDemo(orientation: .vertical)
                ToolDockDemo(orientation: .horizontal)
            }
        }
    }

    private var searchCard: some View {
        GallerySpecimenCard(name: "Search", purpose: "Query, filters, and results together", builtFrom: "Search Bar, Chip Row, Suggestion Menu, Search Results, Filter Panel") {
            SearchDemo()
        }
    }

    private var filterPanelCard: some View {
        GallerySpecimenCard(name: "Filter Panel", purpose: "Faceted multi-select filters", builtFrom: "Collapsible, Chip Row, Checkbox, Form Field") {
            HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
                FilterPanelDemo()
                VStack(alignment: .leading, spacing: 2) {
                    MuiText("Empty", variant: .toolLabel, color: .muted)
                    MuiFilterPanel(groups: [])
                        .frame(width: 200, height: 200)
                        .background(MuiTokens.imageCanvas, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
                }
            }
        }
    }
}

private struct SidebarDemo: View {
    @State private var active: String? = "iceland"
    @State private var expanded = ["trips"]
    var body: some View {
        MuiSidebar(
            sections: [
                MuiSidebarSection(id: "cloud", label: "MAPLE CLOUD", nodes: [
                    MuiSidebarNode(id: "trips", label: "2026 Trips", icon: "folder", children: [
                        MuiSidebarNode(id: "iceland", label: "Iceland", icon: "photo", count: 214),
                        MuiSidebarNode(id: "faroe", label: "Faroe Islands", icon: "photo", count: 88),
                    ]),
                ]),
            ],
            toolbarEntries: [.item(MuiToolbarActionItem(id: "add", icon: "plus", label: "Add source"))],
            contextMenuEntries: [MuiContextMenuItem(id: "rename", label: "Rename")],
            activeId: $active,
            expandedIds: $expanded
        )
        .frame(width: 220, height: 180)
    }
}

private struct ToolDockDemo: View {
    let orientation: MuiToolDockOrientation
    @State private var active: String? = "crop"
    var body: some View {
        MuiToolDock(entries: [
            .item(MuiToolDockItem(id: "crop", icon: "crop", label: "Crop")),
            .item(MuiToolDockItem(id: "adjust", icon: "slider.horizontal.3", label: "Adjust")),
            .divider,
            .item(MuiToolDockItem(id: "heal", icon: "bandage", label: "Heal", disabled: true)),
        ], orientation: orientation, activeId: $active)
    }
}

private struct SearchDemo: View {
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
        .frame(height: 340)
    }
}

private struct FilterPanelDemo: View {
    var body: some View {
        MuiFilterPanel(
            groups: [
                MuiFilterGroup(id: "type", label: "File Type", options: [
                    MuiFilterOption(id: "raw", label: "RAW", checked: true),
                    MuiFilterOption(id: "jpeg", label: "JPEG", checked: false),
                ]),
                MuiFilterGroup(id: "camera", label: "Camera", options: [
                    MuiFilterOption(id: "a7", label: "Sony A7 IV", checked: false),
                ], searchable: true),
            ],
            activeChips: [MuiChip(id: "type:raw", label: "RAW")]
        )
        .frame(width: 260, height: 200)
    }
}
