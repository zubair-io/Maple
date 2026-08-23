// MuiMenuNavMath.swift — pure keyboard-navigation math shared by the
// overlay menus (MuiContextMenu, MuiSuggestionMenu, MuiCommandMenu —
// unified-component-catalog.md §2.4). Mirrors the web reference's
// per-component `onKeydown` handlers, factored into one place since all
// three menus wrap the same "arrow moves the active row" behavior with two
// small variations:
//
// - Context Menu starts with **no** active row (`nil`), skips disabled
//   entries, and only moves among the caller-supplied `selectable` index
//   set.
// - Suggestion/Command Menu start active at index 0 and simply wrap over
//   every visible row (Command Menu's row count changes as the query
//   filters, hence `clampedIndex`).
//
// Kept side-effect-free so it's unit-testable without rendering a view or
// running a key event.

import Foundation

enum MuiMenuNavMath {
    /// Context-menu style: moves among `selectable` indices in `direction`
    /// (`1` = forward/down, `-1` = backward/up). A `nil` (no row yet
    /// highlighted) current enters at the first selectable row moving
    /// forward, or the last moving backward — matching a fresh menu open's
    /// "arrow down highlights the first item" convention. Returns `current`
    /// unchanged when there's nothing selectable to move to.
    static func moveActive(current: Int?, direction: Int, selectable: [Int]) -> Int? {
        guard !selectable.isEmpty else { return current }
        guard let current, let currentPos = selectable.firstIndex(of: current) else {
            return direction >= 0 ? selectable.first : selectable.last
        }
        let count = selectable.count
        let nextPos = ((currentPos + direction) % count + count) % count
        return selectable[nextPos]
    }

    /// Suggestion/command-menu style: simple wraparound over `count` rows
    /// (every row is selectable — filtering already happened upstream).
    /// Returns `0` when `count` is zero (nothing to wrap over).
    static func wrappedIndex(current: Int, direction: Int, count: Int) -> Int {
        guard count > 0 else { return 0 }
        return ((current + direction) % count + count) % count
    }

    /// Command-menu style: clamps a possibly-stale active index (e.g. from
    /// before the query re-filtered the list) into the current row count.
    /// `-1` when there's nothing to select.
    static func clampedIndex(_ index: Int, count: Int) -> Int {
        guard count > 0 else { return -1 }
        return Swift.min(index, count - 1)
    }
}
