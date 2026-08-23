// MoleculesL1SelectionGallery.swift — Molecules L1 tab, catalog §2.2
// Selection: Chip Row, Tabs, Tree Row, List Row, Rating & Flags.

import SwiftUI

extension MoleculesL1GallerySection {
    var chipRowCard: some View {
        GallerySpecimenCard(name: "Chip Row", purpose: "Row of pills — select, apply, or edit", builtFrom: "Badge, Icon, Input") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiChipRow(
                    chips: [MuiChip(id: "raw", label: "RAW"), MuiChip(id: "jpeg", label: "JPEG")],
                    mode: .select,
                    selectedId: .constant("raw")
                )
                MuiChipRow(chips: [MuiChip(id: "1", label: "Sunset"), MuiChip(id: "2", label: "Portrait")], mode: .removable)
            }
        }
    }

    var tabsCard: some View {
        GallerySpecimenCard(name: "Tabs", purpose: "Tab row with selection indicator", builtFrom: "Text, Icon") {
            MuiTabs(
                tabs: [
                    MuiTab(id: "grid", label: "Grid", icon: "square.grid.2x2"),
                    MuiTab(id: "list", label: "List", icon: "list.bullet"),
                    MuiTab(id: "map", label: "Map", icon: "map"),
                ],
                activeId: .constant("list")
            )
        }
    }

    var treeRowCard: some View {
        GallerySpecimenCard(name: "Tree Row", purpose: "One row of a hierarchical tree", builtFrom: "Icon, Text, Badge, Spinner") {
            VStack(spacing: 0) {
                MuiTreeRow(label: "2026 Trips", expandable: true, expanded: .constant(true))
                MuiTreeRow(label: "Iceland", depth: 1, count: 214, active: true)
                MuiTreeRow(label: "Faroe Islands", depth: 1, loading: true)
            }
        }
    }

    var listRowCard: some View {
        GallerySpecimenCard(name: "List Row", purpose: "Row with metadata and inline actions", builtFrom: "Icon, Text, Timestamp, Button") {
            VStack(spacing: 0) {
                MuiListRow(icon: "gearshape", label: "General", active: true, trailing: {
                    MuiIcon(name: "chevron.right", size: .sm, color: MuiTokens.textMuted)
                })
                MuiListRow(icon: "doc", label: "IMG_0042.dng", timestampValue: Date().addingTimeInterval(-120))
            }
        }
    }

    var ratingFlagsCard: some View {
        GallerySpecimenCard(name: "Rating & Flags", purpose: "Star rating plus pick/reject", builtFrom: "Icon, Badge") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiRatingFlags(rating: .constant(3), flag: .constant(.pick))
                MuiRatingFlags(rating: .constant(0), flag: .constant(.reject))
            }
        }
    }
}
