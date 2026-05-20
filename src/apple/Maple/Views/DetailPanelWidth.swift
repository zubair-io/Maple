// DetailPanelWidth.swift — ViewModifier that clamps the detail column's
// width across macOS / iPadOS / iOS. Extracted from AppShell.swift as
// part of the multi-PR AppShell split (#123, slice 1).

import SwiftUI

// MARK: - Detail panel width

/// Platform-scoped column width for the detail pane.
/// - macOS: 240/280/360 — generous, matches the mockup width.
/// - iPad: 240/260/280 — tightened because `NavigationSplitView` on iPad
///   pulls the column toward `max` and ignores `ideal`. Without this clamp
///   the detail pane eats roughly half the screen on a 12.9" iPad in
///   landscape, leaving the slider rail floating in whitespace.
struct DetailPanelWidth: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        if UIDevice.current.userInterfaceIdiom == .pad {
            content.navigationSplitViewColumnWidth(min: 240, ideal: 260, max: 280)
        } else {
            content.navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 360)
        }
        #else
        content.navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 360)
        #endif
    }
}
