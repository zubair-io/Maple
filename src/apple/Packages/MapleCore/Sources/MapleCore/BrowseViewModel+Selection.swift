// BrowseViewModel+Selection.swift — selection behaviour for the browse grid.
//
// Split out of BrowseViewModel.swift for the file-size budget (#2311 headroom
// gate); no behaviour change. The stored properties (`isSelecting`,
// `selectedIDs`, `selectedID`) stay on the class — `@Observable` requires it —
// so only the operations over them live here.
//
// Two selection concepts share this file because they share that state:
// single selection (`selectNext` / `selectPrev`, the highlighted cell) and
// multi-select mode (#1236 / #1234, the checked set feeding panorama merge and
// batch metadata).

import Foundation

extension BrowseViewModel {

    // MARK: - Multi-select (M1 — #1236 / #1234)

    /// True when enough assets are selected to trigger a panorama merge (≥2).
    public var canMergePanorama: Bool { selectedIDs.count >= 2 }

    /// Enter multi-select mode. Does NOT clear any prior single selection.
    public func enterSelectMode() {
        isSelecting = true
    }

    /// Leave multi-select mode and clear all checked assets.
    public func exitSelectMode() {
        isSelecting = false
        selectedIDs = []
    }

    /// Toggle an asset's checked state. No-op if not in select mode.
    public func toggleSelected(_ id: AssetRef.ID) {
        guard isSelecting else { return }
        if selectedIDs.contains(id) {
            selectedIDs.remove(id)
        } else {
            selectedIDs.insert(id)
        }
    }

    /// Select an individual asset. No-op if not in select mode.
    public func select(_ id: AssetRef.ID) {
        guard isSelecting else { return }
        selectedIDs.insert(id)
    }

    /// Deselect an individual asset. No-op if not in select mode.
    public func deselect(_ id: AssetRef.ID) {
        guard isSelecting else { return }
        selectedIDs.remove(id)
    }

    /// Clear all checked assets while staying in select mode.
    public func clearSelection() {
        selectedIDs = []
    }

    /// Ordered list of checked AssetRefs, in the same order they appear in
    /// `assets` (not the order they were checked — `selectedIDs` is an
    /// unordered `Set`). Preserves `assets` order for stable stitching input.
    public var selectedAssets: [AssetRef] {
        assets.filter { selectedIDs.contains($0.id) }
    }

    // MARK: - Single selection

    public func selectNext() {
        guard let idx = assets.firstIndex(where: { $0.id == selectedID }), idx + 1 < assets.count
        else { selectedID = assets.first?.id; return }
        selectedID = assets[idx + 1].id
    }

    public func selectPrev() {
        guard let idx = assets.firstIndex(where: { $0.id == selectedID }), idx > 0
        else { selectedID = assets.last?.id; return }
        selectedID = assets[idx - 1].id
    }
}
