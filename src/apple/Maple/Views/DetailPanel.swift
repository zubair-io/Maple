// DetailPanel.swift — Right-side inspector panel (Info).
//
// Only mounted when the app is in Full-image / editing mode. Browse mode
// drops the detail column entirely (AppShell renders a 2-column
// NavigationSplitView).
//
// The Info surface owns EXIF and metadata. Develop controls live in the
// shared StackedAdjustmentsPanel (#3252), including Profile, white balance
// and Capture Sharpening. A single Info surface needs no tab bar.

import MapleCore
import SwiftUI

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
    // Fill the detail column entirely so resizing doesn't reveal a gap
    // between the panel and the window edge. The column's own width is
    // capped in AppShell via navigationSplitViewColumnWidth.
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(MapleTokens.sidebar)
  }
}

// MARK: - InfoTab + helpers — extracted to `DetailPanelInfoTab.swift` in
// S6 (#621). `InfoTab` is now a thin wrapper around `InfoPanelView`.
