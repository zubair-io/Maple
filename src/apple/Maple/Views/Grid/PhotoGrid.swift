// PhotoGrid.swift — shared photo-grid container with column strategy.
//
// Part of the grid-unify refactor (#1490 M0). Provides:
//   - `ColumnStrategy` — describes how columns are computed per layout
//   - `PhotoGrid`         — flat LazyVGrid of PhotoThumbnailCells
//   - `SectionedPhotoGrid`— LazyVStack of month-labelled PhotoGrids
//
// Column counts / gaps mirror `LibraryGrid` (responsive-program S2, #623):
//   phone   — 3 fixed columns, 2pt gap
//   tablet  — 5 fixed columns, 4pt gap
//   desktop — adaptive 180pt min, 4pt gap

import SwiftUI
import MapleCore

// MARK: - ColumnStrategy

/// Describes how grid columns are computed. Pass one of the three presets
/// or a custom fixed/adaptive value.
enum ColumnStrategy {
    /// Exactly `count` equal-width flexible columns with the given spacing.
    case fixed(Int, spacing: CGFloat = 4)
    /// Adaptive columns filling the width, constrained to `min…max` points.
    case adaptive(min: CGFloat, max: CGFloat = .infinity, spacing: CGFloat = 4)
    /// Picks column count from the `mapleLayout` environment value:
    ///   phone   → 3 fixed, 2pt gap
    ///   tablet  → 5 fixed, 4pt gap
    ///   desktop → adaptive 180pt min, 4pt gap
    case responsiveBySizeClass

    /// Resolve to SwiftUI `GridItem` array given the current `MapleLayout`.
    /// For `.responsiveBySizeClass`, `layout` is read from the environment
    /// before calling this method.
    func gridItems(for layout: MapleLayout) -> [GridItem] {
        switch self {
        case .fixed(let count, let spacing):
            return Array(repeating: GridItem(.flexible(), spacing: spacing), count: count)
        case .adaptive(let min, let max, let spacing):
            return [GridItem(.adaptive(minimum: min, maximum: max), spacing: spacing)]
        case .responsiveBySizeClass:
            switch layout {
            case .phone:
                return Array(repeating: GridItem(.flexible(), spacing: 2), count: 3)
            case .tablet:
                return Array(repeating: GridItem(.flexible(), spacing: 4), count: 5)
            case .desktop:
                return [GridItem(.adaptive(minimum: 180), spacing: 4)]
            }
        }
    }

    /// Inter-row spacing for the grid as a whole. Layout-aware so
    /// `.responsiveBySizeClass` matches its column gap exactly (phone uses a 2pt
    /// gap in BOTH directions per the S2 spec; tablet/desktop use 4pt).
    func rowSpacing(for layout: MapleLayout) -> CGFloat {
        switch self {
        case .fixed(_, let spacing): return spacing
        case .adaptive(_, _, let spacing): return spacing
        case .responsiveBySizeClass: return layout == .phone ? 2 : 4
        }
    }
}

// MARK: - PhotoGrid (flat)

/// A flat `LazyVGrid` of `PhotoThumbnailCell` items.
///
/// Call sites supply `items`, a `ThumbnailProvider`, and the `ColumnStrategy`.
/// Tap routing, selection, and the zoom-transition namespace are all optional
/// so the grid composes cleanly at every surface.
struct PhotoGrid: View {

    let items: [PhotoGridItem]
    let columns: ColumnStrategy
    let provider: ThumbnailProvider
    let displayMode: GridDisplayMode
    var selection: Set<String> = []
    var transitionNamespace: Namespace.ID? = nil
    let onTap: (PhotoGridItem) -> Void

    @Environment(\.mapleLayout) private var layout

    var body: some View {
        LazyVGrid(
            columns: columns.gridItems(for: layout),
            spacing: columns.rowSpacing(for: layout)
        ) {
            ForEach(items) { item in
                PhotoThumbnailCell(
                    item: item,
                    provider: provider,
                    displayMode: displayMode,
                    isSelected: selection.contains(item.id),
                    transitionNamespace: transitionNamespace,
                    onTap: { onTap(item) }
                )
            }
        }
    }
}

// MARK: - SectionedPhotoGrid (month buckets)

/// A `LazyVStack` of month-section headers each followed by a flat `PhotoGrid`.
/// Mirrors the month-bucketed layout in `CloudTimelineMonthSection`.
///
/// `Header` is any `View` the caller provides for each section key (typically
/// a month label `Text`). `SectionedPhotoGrid` itself does not paginate —
/// the caller's `.task(id:)` on each section drives page loads, exactly as
/// `CloudTimelineView` does today.
struct SectionedPhotoGrid<Header: View>: View {

    let sections: [(key: String, items: [PhotoGridItem])]
    let columns: ColumnStrategy
    let provider: ThumbnailProvider
    let displayMode: GridDisplayMode
    var selection: Set<String> = []
    var transitionNamespace: Namespace.ID? = nil
    let onTap: (PhotoGridItem) -> Void
    @ViewBuilder let header: (String) -> Header

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 24) {
            ForEach(sections, id: \.key) { section in
                VStack(alignment: .leading, spacing: 8) {
                    header(section.key)
                    PhotoGrid(
                        items: section.items,
                        columns: columns,
                        provider: provider,
                        displayMode: displayMode,
                        selection: selection,
                        transitionNamespace: transitionNamespace,
                        onTap: onTap
                    )
                }
            }
        }
    }
}

// MARK: - Previews

private func previewItems(count: Int, style: OverlayStyle = .phone) -> [PhotoGridItem] {
    (0..<count).map { i in
        PhotoGridItem(
            id: "prev-\(i)",
            thumbnailSource: .photoKit(localID: "local-\(i)"),
            overlays: GridCellOverlays(
                rating: i % 6,
                flag: i % 4 == 0 ? .pick : nil,
                style: style
            )
        )
    }
}

#Preview("Flat — .fixed(3)") {
    ScrollView {
        PhotoGrid(
            items: previewItems(count: 12),
            columns: .fixed(3, spacing: 2),
            provider: .preview(),
            displayMode: .fill,
            onTap: { _ in }
        )
        .padding(2)
    }
    .frame(width: 390, height: 600)
    .background(MapleTokens.bg)
}

#Preview("Flat — .adaptive(min:140)") {
    ScrollView {
        PhotoGrid(
            items: previewItems(count: 12, style: .desktop),
            columns: .adaptive(min: 140, spacing: 4),
            provider: .preview(),
            displayMode: .fill,
            onTap: { _ in }
        )
        .padding(4)
    }
    .frame(width: 720, height: 600)
    .background(MapleTokens.bg)
}

#Preview("Flat — .responsiveBySizeClass") {
    ScrollView {
        PhotoGrid(
            items: previewItems(count: 12),
            columns: .responsiveBySizeClass,
            provider: .preview(),
            displayMode: .fill,
            selection: Set(["prev-0", "prev-2"]),
            onTap: { _ in }
        )
        .padding(2)
    }
    .frame(width: 390, height: 600)
    .background(MapleTokens.bg)
}

#Preview("Sectioned — month buckets") {
    let months = ["June 2026", "May 2026"]
    let sections = months.enumerated().map { (i, key) in
        (key: key, items: previewItems(count: 8, style: .desktop).map {
            PhotoGridItem(id: "\(i)-\($0.id)", thumbnailSource: $0.thumbnailSource,
                          overlays: $0.overlays)
        })
    }
    ScrollView {
        SectionedPhotoGrid(
            sections: sections,
            columns: .fixed(4, spacing: 6),
            provider: .preview(),
            displayMode: .fill,
            onTap: { _ in }
        ) { key in
            Text(key)
                .font(.title3.bold())
                .padding(.horizontal, 16)
        }
        .padding(.vertical, 12)
    }
    .frame(width: 720, height: 700)
    .background(MapleTokens.bg)
}
