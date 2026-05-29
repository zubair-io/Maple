// LibraryGrid.swift — responsive-program S2 (#623). Responsive photo
// grid for the Library tab.
//
// Drives column count, gap, and outer padding off the
// `@Environment(\.mapleLayout)` density signal published by AppShell:
//
//   * phone   — 3 fixed columns, 2pt gaps, 2pt horizontal padding
//               (edge-bleed: no vertical padding).
//   * tablet  — 5 fixed columns, 4pt gaps, 8pt outer padding.
//   * desktop — adaptive tracks at `minmax(180pt, 1fr)`, 4pt gaps,
//               12pt outer padding. Mirrors the web spec's CSS
//               `repeat(auto-fill, minmax(180px, 1fr))` rule.
//
// Filter chip row sits above the grid (single-select; persisted to
// `@AppStorage("cm.filter")`). Cell tap routes through `onOpenEditor`
// (same callback BrowseGrid uses — the iPhone shell already pushes the
// Editor via `.navigationDestination(for: AssetRef.self)`).
//
// Spec: docs/design/responsive-program/s2-library-grid.md.
//
// NOTE on filter wiring: the cull state (`stars`, `flag`) lives on
// `EditSession`, which the iPhone shell creates lazily as cells appear
// (`onPrimeSession`). So filters that key off culling state only see
// sessions for cells that have appeared on screen. Acceptable v0.1
// limitation — documented here and in the PR body — because eagerly
// priming sessions would defeat the lazy-load budget. The "edited"
// filter is a no-op today; `AssetRef.hasEdits` doesn't exist yet and
// is tracked separately (KTLO follow-up). See the spec §6 risks.

#if os(iOS)

import SwiftUI
import MapleCore
#if canImport(UIKit)
import UIKit
#endif

struct LibraryGrid: View {
    @Environment(\.mapleLayout) private var layout

    let vm: BrowseViewModel
    let source: (any ImageSource)?
    /// In-content title (spec §2 phone: Merriweather 28pt/700,
    /// tracking -0.5pt, current source name). Caller passes the active
    /// source label — typically `AppShell.libraryTitle`.
    let title: String
    @Binding var sessions: [AssetRef.ID: EditSession]
    @Binding var displayMode: GridDisplayMode

    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void

    @AppStorage("cm.filter") private var filter: String = LibraryFilter.all.rawValue

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(MapleTokens.Typography.sourceTitle)
                    .tracking(-0.5)
                    .foregroundStyle(MapleTokens.textMain)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
                    .accessibilityIdentifier("library-grid-title")

                FilterChipRow(active: $filter)

                LazyVGrid(columns: columns, spacing: gridGap) {
                    ForEach(filteredAssets) { asset in
                        LibraryCell(
                            asset: asset,
                            isSelected: vm.selectedID == asset.id,
                            session: sessions[asset.id],
                            source: source,
                            displayMode: displayMode,
                            style: .phone
                        )
                        .id(asset.id)
                        .contentShape(Rectangle())
                        .onAppear { onPrimeSession(asset) }
                        .onTapGesture {
                            vm.selectedID = asset.id
                            // Selection haptic — matches the spec §2 phone
                            // interaction model (`.selection` on iOS).
                            #if canImport(UIKit)
                            UISelectionFeedbackGenerator().selectionChanged()
                            #endif
                            // Routes through AppShell's mode flip
                            // (`.browse` → `.fullImage`). S5 will replace
                            // this with a `NavigationLink(value: AssetRef)`
                            // push so the spec §2 "tab-bar hide on push"
                            // contract — wired in `PhoneLibraryView`'s
                            // `.navigationDestination(for: AssetRef.self)`
                            // — actually fires. Today the FullImageView
                            // mounts in-place inside the tab, so the tab
                            // bar stays visible (known deviation, noted
                            // in the PR body).
                            onOpenEditor(asset)
                        }
                    }
                }
                .padding(.horizontal, outerHorizontalPadding)
                .accessibilityIdentifier("library-grid")
                // The cross-fade on filter swap; transition the grid id with
                // the filter so SwiftUI re-mounts the content list and the
                // 120ms linear fade lands.
                .id("library-grid-\(filter)")
                .transition(.opacity)
            }
        }
        .background(MapleTokens.bg)
    }

    // MARK: - Layout

    private var columns: [GridItem] {
        switch layout {
        case .phone:
            return Array(repeating: GridItem(.flexible(), spacing: gridGap), count: 3)
        case .tablet:
            return Array(repeating: GridItem(.flexible(), spacing: gridGap), count: 5)
        case .desktop:
            return [GridItem(.adaptive(minimum: 180), spacing: gridGap)]
        }
    }

    private var gridGap: CGFloat {
        layout == .phone ? 2 : 4
    }

    private var outerHorizontalPadding: CGFloat {
        switch layout {
        case .phone:   return 2
        case .tablet:  return 8
        case .desktop: return 12
        }
    }

    // MARK: - Filtering

    /// Apply the active filter to `vm.assets`. Pure on (assets, sessions,
    /// filter) — surfaced as a top-level helper for unit tests in
    /// `LibraryGridFilterTests`.
    var filteredAssets: [AssetRef] {
        Self.applyFilter(filter,
                         to: vm.assets,
                         sessions: sessions)
    }

    static func applyFilter(
        _ raw: String,
        to assets: [AssetRef],
        sessions: [AssetRef.ID: EditSession]
    ) -> [AssetRef] {
        let f = LibraryFilter(rawValue: raw) ?? .all
        switch f {
        case .all:
            return assets
        case .picks:
            return assets.filter { sessions[$0.id]?.culling.flag == .pick }
        case .fourStars:
            return assets.filter { (sessions[$0.id]?.culling.stars ?? 0) >= 4 }
        case .edited:
            // `AssetRef.hasEdits` is tracked at #628 (no model field
            // today). Returning empty until that lands keeps the chip
            // selectable but content-free, matching the doc'd v0.1 stub
            // behaviour. The companion `LibraryGridFilterTests` case
            // gets flipped from "asserts empty" to a real assertion in
            // the same PR that adds the field.
            return []
        }
    }
}

#endif
