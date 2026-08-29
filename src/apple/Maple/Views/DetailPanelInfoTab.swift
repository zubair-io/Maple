// DetailPanelInfoTab.swift — the Info-tab body of `DetailPanel`.
//
// Extracted from `DetailPanel.swift` in S6 (#621) so the parent file
// stays under the file-budget soft cap (per CLAUDE.md / S1b agent's
// 594-line report). The Info-tab body itself is now a thin wrapper
// around `InfoPanelView` from the responsive-program S6 panel — same
// content, two slots: this slot (tablet/desktop right pane) and the
// phone bottom sheet (S1c `.mapleBottomSheet`, wired in S5 Editor).
//
// `InfoTab` keeps the same name + initializer the rest of `DetailPanel`
// already calls so the swap is invisible to existing call sites.
//
// The `InfoRow` / `SectionHeader` ad-hoc row helpers that used to live
// here were deleted in the Maple UI adoption epic (#3019, wave MA3) —
// `git grep` proved zero consumers anywhere in the app target; the S6
// panel's own rows render through `CameraLocationGrid`, which now
// delegates to MapleUI's `MuiLabelValueGrid`.

import MapleCore
import SwiftUI

// MARK: - InfoTab

struct InfoTab: View {
  let session: EditSession?

  var body: some View {
    InfoPanelView(session: session, isInsideSheet: false)
  }
}
