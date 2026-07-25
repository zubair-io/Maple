// PhotoGrid.swift — shared photo-grid container with column strategy.
//
// Part of the grid-unify refactor (#1490 M0). Provides:
//   - `ColumnStrategy` — describes how columns are computed per layout
//   - `PhotoGrid`         — flat LazyVGrid mapping a source collection to cells
//
// Column counts / gaps mirror `LibraryGrid` (responsive-program S2, #623):
//   phone   — 3 fixed columns, 2pt gap
//   tablet  — 5 fixed columns, 4pt gap
//   desktop — adaptive 180pt min, 4pt gap
//
// Lazy mapping (#1530 / #1490 M1a review): the grid takes the call site's
// source collection (`data: [Element]`) plus a `makeItem` transform, and builds
// each `PhotoGridItem` INSIDE the `LazyVGrid`'s `ForEach`. Only realized
// (on-screen) cells derive their item + overlays — off-screen assets cost
// nothing, and overlay state stays live (it's read per visible cell, not
// snapshotted into an eagerly-built array). The element is handed back through
// `onTap`/`onAppearItem`, so call sites need no id→element reverse lookup.
//
// M1b addition (#1490): optional `multiSelectChecked` closure. When provided,
// the closure is called per visible element and its result is forwarded to
// `PhotoThumbnailCell.multiSelectChecked`. `nil` (default) keeps the existing
// single-select outline behaviour unchanged.

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

/// A flat `LazyVGrid` that maps a source collection (`data`) to
/// `PhotoThumbnailCell`s via `makeItem`, mapping each element lazily inside the
/// `ForEach` (only realized cells build their item + derive overlays).
///
/// `selection` is keyed by `Element.ID`; `onTap` / `onAppearItem` hand the
/// element back so call sites avoid any id→element reverse lookup. The optional
/// `leading` slot renders INSIDE the same `LazyVGrid` before the photo cells, so
/// folder cells keep the interleaved column flow (no reflow).
///
/// `multiSelectChecked` — when non-nil, is called per visible element and the
/// result is forwarded to `PhotoThumbnailCell.multiSelectChecked`. Enables the
/// top-trailing checkmark badge (BrowseGrid multi-select) without polluting the
/// `PhotoGridItem` model with UI-only state.
struct PhotoGrid<Element: Identifiable, Leading: View>: View {

    let data: [Element]
    let columns: ColumnStrategy
    let provider: ThumbnailProvider
    let displayMode: GridDisplayMode
    var selection: Set<Element.ID> = []
    var transitionNamespace: Namespace.ID? = nil
    var onAppearItem: ((Element) -> Void)? = nil
    /// Optional multi-select badge state per element. When non-nil, the closure
    /// is called for each visible element and the result is passed to
    /// `PhotoThumbnailCell.multiSelectChecked`. `nil` preserves the single-select
    /// outline behaviour of the original grid surfaces.
    var multiSelectChecked: ((Element) -> Bool?)? = nil
    let onTap: (Element) -> Void
    /// Zoom-to-open tap handler (#1489). When set it SUPERSEDES `onTap` and
    /// each cell hands back its painted thumbnail + global frame (or `nil`
    /// when it has none yet) so the surface can fly it into the editor.
    var onHeroTap: ((Element, PhotoGridHeroSource?) -> Void)? = nil
    let makeItem: (Element) -> PhotoGridItem
    let leading: () -> Leading

    @Environment(\.mapleLayout) private var layout

    /// Primary initialiser. Explicit so `leading` can carry `@ViewBuilder`.
    /// Use the `EmptyView` convenience below when no leading content is needed.
    init(
        data: [Element],
        columns: ColumnStrategy,
        provider: ThumbnailProvider,
        displayMode: GridDisplayMode,
        selection: Set<Element.ID> = [],
        transitionNamespace: Namespace.ID? = nil,
        onAppearItem: ((Element) -> Void)? = nil,
        multiSelectChecked: ((Element) -> Bool?)? = nil,
        onTap: @escaping (Element) -> Void,
        onHeroTap: ((Element, PhotoGridHeroSource?) -> Void)? = nil,
        makeItem: @escaping (Element) -> PhotoGridItem,
        @ViewBuilder leading: @escaping () -> Leading
    ) {
        self.data = data
        self.columns = columns
        self.provider = provider
        self.displayMode = displayMode
        self.selection = selection
        self.transitionNamespace = transitionNamespace
        self.onAppearItem = onAppearItem
        self.multiSelectChecked = multiSelectChecked
        self.onTap = onTap
        self.onHeroTap = onHeroTap
        self.makeItem = makeItem
        self.leading = leading
    }

    var body: some View {
        LazyVGrid(
            columns: columns.gridItems(for: layout),
            spacing: columns.rowSpacing(for: layout)
        ) {
            leading()
            ForEach(data) { element in
                // Map to a PhotoGridItem here, inside the LazyVGrid's ForEach, so
                // only realized (visible) cells build their item + derive overlays.
                let item = makeItem(element)
                PhotoThumbnailCell(
                    item: item,
                    provider: provider,
                    displayMode: displayMode,
                    isSelected: selection.contains(element.id),
                    transitionNamespace: transitionNamespace,
                    multiSelectChecked: multiSelectChecked?(element),
                    onTap: { onTap(element) },
                    onHeroTap: onHeroTap.map { cb in { source in cb(element, source) } },
                    onAppear: onAppearItem.map { cb in { cb(element) } }
                )
                // Tag each photo cell so ScrollViewReader.scrollTo can target it.
                .id(element.id)
            }
        }
    }
}

// MARK: - EmptyView convenience initialiser (no leading content)

extension PhotoGrid where Leading == EmptyView {
    init(
        data: [Element],
        columns: ColumnStrategy,
        provider: ThumbnailProvider,
        displayMode: GridDisplayMode,
        selection: Set<Element.ID> = [],
        transitionNamespace: Namespace.ID? = nil,
        onAppearItem: ((Element) -> Void)? = nil,
        multiSelectChecked: ((Element) -> Bool?)? = nil,
        onTap: @escaping (Element) -> Void,
        onHeroTap: ((Element, PhotoGridHeroSource?) -> Void)? = nil,
        makeItem: @escaping (Element) -> PhotoGridItem
    ) {
        self.init(
            data: data,
            columns: columns,
            provider: provider,
            displayMode: displayMode,
            selection: selection,
            transitionNamespace: transitionNamespace,
            onAppearItem: onAppearItem,
            multiSelectChecked: multiSelectChecked,
            onTap: onTap,
            onHeroTap: onHeroTap,
            makeItem: makeItem,
            leading: { EmptyView() }
        )
    }
}

// MARK: - Previews

private func previewItems(count: Int, style: OverlayStyle = .phone) -> [PhotoGridItem] {
    (0..<count).map { i in
        PhotoGridItem(
            id: "prev-\(i)",
            displayName: "IMG_\(String(format: "%04d", i)).dng",
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
            data: previewItems(count: 12),
            columns: .fixed(3, spacing: 2),
            provider: .preview(),
            displayMode: .fill,
            onTap: { _ in },
            makeItem: { $0 }
        )
        .padding(2)
    }
    .frame(width: 390, height: 600)
    .background(MapleTokens.bg)
}

#Preview("Flat — .adaptive(min:140)") {
    ScrollView {
        PhotoGrid(
            data: previewItems(count: 12, style: .desktop),
            columns: .adaptive(min: 140, spacing: 4),
            provider: .preview(),
            displayMode: .fill,
            onTap: { _ in },
            makeItem: { $0 }
        )
        .padding(4)
    }
    .frame(width: 720, height: 600)
    .background(MapleTokens.bg)
}

#Preview("Flat — .responsiveBySizeClass") {
    ScrollView {
        PhotoGrid(
            data: previewItems(count: 12),
            columns: .responsiveBySizeClass,
            provider: .preview(),
            displayMode: .fill,
            selection: Set(["prev-0", "prev-2"]),
            onTap: { _ in },
            makeItem: { $0 }
        )
        .padding(2)
    }
    .frame(width: 390, height: 600)
    .background(MapleTokens.bg)
}

#Preview("Multi-select badges") {
    let items = previewItems(count: 9, style: .desktop)
    let checkedIDs = Set(["prev-0", "prev-2", "prev-5"])
    ScrollView {
        PhotoGrid(
            data: items,
            columns: .adaptive(min: 140, spacing: 4),
            provider: .preview(),
            displayMode: .fill,
            selection: checkedIDs,
            multiSelectChecked: { item in checkedIDs.contains(item.id) },
            onTap: { _ in },
            makeItem: { $0 }
        )
        .padding(4)
    }
    .frame(width: 720, height: 600)
    .background(MapleTokens.bg)
}
