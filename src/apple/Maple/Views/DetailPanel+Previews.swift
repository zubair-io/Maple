// DetailPanel+Previews.swift — SwiftUI #Preview blocks for DetailPanel.
//
// Extracted from DetailPanel.swift in PR #318 to keep the main file under
// the 600-LOC hard budget. Issue #139 — the three-column-shell's right-hand
// detail panel. Two meaningful states: `nil` session (empty placeholder)
// and a populated session driven by `EditSession.preview()`. The Info
// surface's EXIF table will be empty because the preview asset has no
// on-disk bytes. The Develop tab was removed in #875 — the panel is now
// Info-only.

import SwiftUI
import MapleCore

#Preview("Loaded — Info") {
    DetailPanel(session: EditSession.preview())
        .frame(width: 320, height: 700)
}

#Preview("Empty (no session)") {
    DetailPanel(session: nil)
        .frame(width: 320, height: 700)
}
