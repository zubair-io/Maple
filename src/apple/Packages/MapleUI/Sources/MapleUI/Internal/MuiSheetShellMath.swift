// MuiSheetShellMath.swift — pure detent + drag-to-dismiss math for
// MuiSheetShell (Templates, unified-component-catalog.md §5). Kept
// side-effect-free so it's unit-testable without a live drag gesture.
// Ports the web reference's `mui-sheet-shell.component.ts` +
// `internal/sheet-drag.ts` decisions, and matches the app's own
// `BottomSheet.swift` dismiss-distance fraction (25% of sheet height).

import Foundation

enum MuiSheetShellMath {
    /// Pan-down threshold as a fraction of sheet height. Matches
    /// `BottomSheet.swift`'s spec-driven constant and the web reference's
    /// `DISMISS_FRACTION`.
    static let dismissFraction: Double = 0.25

    /// The active detent's height fraction (0–1] of the container height.
    /// Falls back to the first detent — or `0.4` if `detents` is somehow
    /// empty — for an out-of-range index, so a caller can't crash this by
    /// mutating `activeDetent` out of bounds.
    static func heightFraction(detents: [Double], activeDetent: Int) -> Double {
        guard detents.indices.contains(activeDetent) else {
            return detents.first ?? 0.4
        }
        return detents[activeDetent]
    }

    /// True once a pan-down drag has crossed the dismiss distance — `dy`
    /// (the pan-down offset) at least `fraction` of the sheet's own height.
    /// `false` for a not-yet-measured (zero-height) sheet.
    static func isDistanceDismissed(dy: Double, sheetHeight: Double, fraction: Double = dismissFraction) -> Bool {
        sheetHeight > 0 && dy >= sheetHeight * fraction
    }
}
