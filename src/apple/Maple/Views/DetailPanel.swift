// DetailPanel.swift — Right-side inspector panel (Info).
//
// Only mounted when the app is in Full-image / editing mode. Browse mode
// drops the detail column entirely (AppShell renders a 2-column
// NavigationSplitView).
//
// As of #875 the panel shows ONLY the Info surface (EXIF + metadata). The
// Develop tab was removed — develop controls live in the S5 EditorView's
// bottom area (DragBar + ToolPillRow + GroupTabsView), not in a right-pane
// tab. With a single surface there's no tab bar; `InfoTab` renders directly.
//
// NOTE (#875): the removed Develop tab was the SOLE surface for three
// controls that have no equivalent in the bottom `Tool` system — the
// Profile (Auto/Neutral) picker, the "As Shot" white-balance reset, and
// Capture Sharpening (Amount/Sigma). Those are now unreachable on Apple.
// `ProfilePicker.swift` is retained (unused) pending a product decision on
// where Profile / Capture Sharpening should live in the S5 editor chrome.

import SwiftUI
import MapleCore

// MARK: - DetailPanel

struct DetailPanel: View {
    /// The active editing session. `nil` when no image is selected — the
    /// panel stays visible (Info shows em-dash rows) so the layout doesn't
    /// jump.
    let session: EditSession?

    var body: some View {
        ScrollView {
            InfoTab(session: session)
        }
        .background(MapleTokens.sidebar)
        // Fill the detail column entirely so resizing doesn't reveal a gap
        // between the panel and the window edge. The column's own width is
        // capped in AppShell via navigationSplitViewColumnWidth.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MapleTokens.sidebar)
    }
}

// MARK: - InfoTab + helpers — extracted to `DetailPanelInfoTab.swift` in
// S6 (#621). `InfoTab` is now a thin wrapper around `InfoPanelView`.
