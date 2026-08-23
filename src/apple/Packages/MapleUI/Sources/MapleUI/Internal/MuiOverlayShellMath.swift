// MuiOverlayShellMath.swift — pure size→max-width mapping for
// MuiOverlayShell (Templates, unified-component-catalog.md §5). Matches the
// web reference's `mui-overlay-shell.component.scss` size classes
// (`.size-sm` / `.size-md` / `.size-lg` / `.size-full`) so the two
// platforms present visually consistent modal widths.

import Foundation

enum MuiOverlayShellMath {
    /// The panel's max width in points for `size`, or `nil` for `.full`
    /// (no cap — the panel fills the available width).
    static func maxWidth(for size: MuiOverlayShellSize) -> Double? {
        switch size {
        case .sm: return 360
        case .md: return 560
        case .lg: return 800
        case .full: return nil
        }
    }
}
