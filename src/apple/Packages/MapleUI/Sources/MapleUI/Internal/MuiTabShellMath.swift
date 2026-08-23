// MuiTabShellMath.swift — pure placement-resolution math for MuiTabShell
// (Templates, unified-component-catalog.md §5). "auto" resolves by host
// width rather than a hardware size class: the web reference's container
// query switches to a bottom tab bar below 640px, and on Apple platforms a
// width that narrow only ever happens on a phone in portrait, so a single
// width check reproduces the "top on tablet/desktop, bottom on phone"
// platform idiom without a separate size-class code path.

import Foundation

enum MuiTabShellMath {
    /// Matches the web reference's tab-shell container-query breakpoint.
    static let bottomBelowWidthPx: Double = 640

    /// Whether the tab bar renders at the bottom edge for `placement` at
    /// the given host width.
    static func isBottom(placement: MuiTabShellPlacement, hostWidth: Double) -> Bool {
        switch placement {
        case .top: return false
        case .bottom: return true
        case .auto: return hostWidth < bottomBelowWidthPx
        }
    }
}
