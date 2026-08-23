// MuiCollectionGrid.swift — Maple UI Organisms · Collections
// (unified-component-catalog.md §4.1). Virtualized selectable thumbnail
// grid, built from Media Cell, Empty State, Spinner, Drag Preview.
//
// SwiftUI's `LazyVGrid` already virtualizes rows as they scroll into view,
// so — unlike the web reference's hand-rolled `scrollTop`-driven windowing
// (needed because jsdom has no real layout engine to measure against) —
// this organism just lays every item into a `LazyVGrid` and lets the
// platform do the windowing.
//
// Multi-select mirrors the familiar file-manager contract: a plain click
// replaces the selection; Cmd-click toggles one item; Shift-click selects
// the contiguous range from the last plain-click anchor. The reducer that
// decides the next selection (`selectionAfterClick`) is a pure static
// function so it's unit-testable without driving a live gesture — the
// view wires it to three gesture recognizers (`.modifiers(.shift)`,
// `.modifiers(.command)`, and MuiMediaCell's own plain `pressed`), with
// the modifier-aware ones marked `.highPriorityGesture` so they preempt
// the plain tap only when their modifier is actually held.
//
// Rating/flag/filename edits happen in place on the cell (MuiMediaCell
// needs live `Binding`s for all three), so this organism keeps a small
// `workingItems` copy resynced from `items` on every external change —
// same "caller owns truth, view keeps a live working copy" shape as
// MuiKanbanBoard's `workingColumns`.

import SwiftUI

public struct MuiCollectionItem: Identifiable, Sendable {
    public let id: String
    public let url: URL?
    public let alt: String
    public var filename: String
    public var badges: [String]
    public var rating: Int
    public var flag: MuiRatingFlagState

    public init(
        id: String,
        url: URL?,
        alt: String,
        filename: String = "",
        badges: [String] = [],
        rating: Int = 0,
        flag: MuiRatingFlagState = .none
    ) {
        self.id = id
        self.url = url
        self.alt = alt
        self.filename = filename
        self.badges = badges
        self.rating = rating
        self.flag = flag
    }
}

public struct MuiCollectionGrid: View {
    public let items: [MuiCollectionItem]
    public let loading: Bool
    public let error: String?
    public let emptyMessage: String
    public let columns: Int
    @Binding public var selectedIds: [String]
    public let opened: ((String) -> Void)?
    public let renamed: ((String, String) -> Void)?
    public let ratingChanged: ((String, Int) -> Void)?
    public let flagChanged: ((String, MuiRatingFlagState) -> Void)?
    public let dragStarted: (([String]) -> Void)?

    @State private var workingItems: [MuiCollectionItem] = []
    @State private var anchorId: String?

    public init(
        items: [MuiCollectionItem],
        loading: Bool = false,
        error: String? = nil,
        emptyMessage: String = "No items to show.",
        columns: Int = 4,
        selectedIds: Binding<[String]> = .constant([]),
        opened: ((String) -> Void)? = nil,
        renamed: ((String, String) -> Void)? = nil,
        ratingChanged: ((String, Int) -> Void)? = nil,
        flagChanged: ((String, MuiRatingFlagState) -> Void)? = nil,
        dragStarted: (([String]) -> Void)? = nil
    ) {
        self.items = items
        self.loading = loading
        self.error = error
        self.emptyMessage = emptyMessage
        self.columns = columns
        self._selectedIds = selectedIds
        self.opened = opened
        self.renamed = renamed
        self.ratingChanged = ratingChanged
        self.flagChanged = flagChanged
        self.dragStarted = dragStarted
    }

    public var body: some View {
        Group {
            if loading {
                MuiSpinner(placement: .centered, label: "Loading items")
            } else if let error {
                MuiEmptyState(icon: "exclamationmark.triangle", title: "Couldn't load items", message: error)
            } else if items.isEmpty {
                MuiEmptyState(icon: "photo.on.rectangle.angled", title: "No items", message: emptyMessage)
            } else {
                grid
            }
        }
        .onAppear { workingItems = items }
        .onChange(of: items.map(\.id)) { _, _ in workingItems = items }
    }

    private var gridColumns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: MuiTokens.spacingSm), count: max(1, columns))
    }

    private var grid: some View {
        ScrollView {
            LazyVGrid(columns: gridColumns, spacing: MuiTokens.spacingMd) {
                ForEach(workingItems) { item in
                    cell(for: item)
                }
            }
            .padding(MuiTokens.spacingSm)
        }
    }

    private func cell(for item: MuiCollectionItem) -> some View {
        MuiMediaCell(
            url: item.url,
            alt: item.alt,
            filename: filenameBinding(for: item.id),
            badges: item.badges,
            selected: selectedIds.contains(item.id),
            rating: ratingBinding(for: item.id),
            flag: flagBinding(for: item.id),
            pressed: { applyClick(id: item.id, shift: false, command: false) },
            renamed: { renamed?(item.id, $0) }
        )
        // `Gesture.modifiers(_:)` (reading held keyboard modifiers off a
        // tap) is a macOS-only SwiftUI API — unavailable on iOS, where
        // touch has no cmd/shift-click concept in the first place. Cmd/
        // shift multi-select is therefore macOS-only, matching the wave
        // brief ("multi-select with cmd/shift semantics on macOS"); iOS
        // falls back to MuiMediaCell's own plain `pressed` above, which
        // still runs `applyClick` with both modifiers false.
        #if os(macOS)
        .highPriorityGesture(
            TapGesture().modifiers(.shift).onEnded { applyClick(id: item.id, shift: true, command: false) }
        )
        .highPriorityGesture(
            TapGesture().modifiers(.command).onEnded { applyClick(id: item.id, shift: false, command: true) }
        )
        #endif
        .simultaneousGesture(TapGesture(count: 2).onEnded { opened?(item.id) })
        .onDrag {
            startDrag(id: item.id)
            return NSItemProvider(object: item.id as NSString)
        }
    }

    private func applyClick(id: String, shift: Bool, command: Bool) {
        let result = Self.selectionAfterClick(
            orderedIds: items.map(\.id),
            current: selectedIds,
            anchor: anchorId,
            tapped: id,
            shift: shift,
            commandOrControl: command
        )
        selectedIds = result.selection
        anchorId = result.anchor
    }

    private func startDrag(id: String) {
        let next = Self.selectionAfterDragStart(current: selectedIds, draggedId: id)
        if next != selectedIds { selectedIds = next }
        dragStarted?(next)
    }

    private func filenameBinding(for id: String) -> Binding<String> {
        Binding(
            get: { workingItems.first(where: { $0.id == id })?.filename ?? "" },
            set: { newValue in
                if let idx = workingItems.firstIndex(where: { $0.id == id }) {
                    workingItems[idx].filename = newValue
                }
            }
        )
    }

    private func ratingBinding(for id: String) -> Binding<Int> {
        Binding(
            get: { workingItems.first(where: { $0.id == id })?.rating ?? 0 },
            set: { newValue in
                if let idx = workingItems.firstIndex(where: { $0.id == id }) {
                    workingItems[idx].rating = newValue
                }
                ratingChanged?(id, newValue)
            }
        )
    }

    private func flagBinding(for id: String) -> Binding<MuiRatingFlagState> {
        Binding(
            get: { workingItems.first(where: { $0.id == id })?.flag ?? .none },
            set: { newValue in
                if let idx = workingItems.firstIndex(where: { $0.id == id }) {
                    workingItems[idx].flag = newValue
                }
                flagChanged?(id, newValue)
            }
        )
    }

    // MARK: - Pure selection logic (unit-testable without a live gesture)

    /// The selection (and new shift-click anchor) after a click on
    /// `tapped`. Mirrors the web reference's file-manager contract: a
    /// plain click replaces the selection and re-anchors; Cmd/Ctrl-click
    /// toggles just the tapped item and leaves the anchor as-is;
    /// Shift-click selects the contiguous run between the anchor and the
    /// tapped item (falling back to a plain single-select if the anchor
    /// no longer exists in `orderedIds`).
    public static func selectionAfterClick(
        orderedIds: [String],
        current: [String],
        anchor: String?,
        tapped: String,
        shift: Bool,
        commandOrControl: Bool
    ) -> (selection: [String], anchor: String?) {
        if shift, let anchor, orderedIds.contains(anchor) {
            return (contiguousRange(orderedIds: orderedIds, from: anchor, to: tapped), anchor)
        }
        if commandOrControl {
            let next = current.contains(tapped) ? current.filter { $0 != tapped } : current + [tapped]
            return (next, anchor)
        }
        return ([tapped], tapped)
    }

    /// A drag on an item that isn't already part of the selection
    /// promotes it to a one-item selection first — dragging an unselected
    /// thumbnail must never drag the whole prior selection along with it.
    public static func selectionAfterDragStart(current: [String], draggedId: String) -> [String] {
        current.contains(draggedId) ? current : [draggedId]
    }

    private static func contiguousRange(orderedIds: [String], from anchor: String, to target: String) -> [String] {
        guard let a = orderedIds.firstIndex(of: anchor), let b = orderedIds.firstIndex(of: target) else {
            return [target]
        }
        let lo = min(a, b), hi = max(a, b)
        return Array(orderedIds[lo...hi])
    }
}

#Preview("MuiCollectionGrid — Populated") {
    struct Demo: View {
        @State private var selected: [String] = ["2"]
        var body: some View {
            MuiCollectionGrid(
                items: (1...12).map { MuiCollectionItem(id: "\($0)", url: nil, alt: "Photo \($0)", filename: "IMG_00\($0).dng", badges: $0 % 3 == 0 ? ["RAW"] : []) },
                columns: 4,
                selectedIds: $selected
            )
            .frame(height: 420)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}

#Preview("MuiCollectionGrid — Loading / Empty / Error") {
    VStack(spacing: 0) {
        MuiCollectionGrid(items: [], loading: true).frame(height: 140)
        MuiDivider()
        MuiCollectionGrid(items: [], emptyMessage: "No photos in this album yet.").frame(height: 140)
        MuiDivider()
        MuiCollectionGrid(items: [], error: "The network share is unreachable.").frame(height: 140)
    }
    .background(MuiTokens.bg)
}
