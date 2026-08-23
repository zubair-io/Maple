// MuiDrawerShellMath.swift — pure edge + drag-to-dismiss math for
// MuiDrawerShell (Templates, unified-component-catalog.md §5). Kept
// side-effect-free so it's unit-testable without a live drag gesture.
// Ports the web reference's `mui-drawer-shell.component.ts` decisions —
// same 30%-of-width dismiss threshold as `SourcePickerDrawerComponent`.

import Foundation

enum MuiDrawerShellMath {
    /// Pan-to-dismiss threshold as a fraction of the panel's width. Matches
    /// the web reference's `DISMISS_FRACTION`.
    static let dismissFraction: Double = 0.3

    /// Sign of "closing" motion for `edge`: a left drawer closes on a
    /// leftward drag (negative dx); a right drawer closes on a rightward
    /// drag (positive dx).
    static func closingSign(edge: MuiDrawerShellEdge) -> Double {
        edge == .left ? -1 : 1
    }

    /// Clamps a raw horizontal drag delta to the closing direction for
    /// `edge` — dragging the "wrong" way while at rest is a no-op, matching
    /// the web reference.
    static func closingDelta(rawDx: Double, edge: MuiDrawerShellEdge) -> Double {
        rawDx * closingSign(edge: edge) > 0 ? rawDx : 0
    }

    /// True once a closing-direction drag has crossed the dismiss distance.
    static func isDismissed(dx: Double, width: Double, fraction: Double = dismissFraction) -> Bool {
        width > 0 && abs(dx) >= width * fraction
    }
}
