// DetailPanel+Previews.swift — SwiftUI #Preview blocks for DetailPanel.
//
// Extracted from DetailPanel.swift in PR #318 to keep the main file under
// the 600-LOC hard budget. Issue #139 — the three-column-shell's right-hand
// detail panel. Two meaningful states: `nil` session (empty placeholder)
// and a populated session driven by `EditSession.preview()`. The Info tab's
// EXIF table will be empty because the preview asset has no on-disk bytes;
// the Develop tab renders all sliders against the model defaults.
//
// The full DetailPanel split is tracked in #319; this is the minimal
// extraction that unblocks the capture-sharpening section without
// growing the file-budget allowlist.

import SwiftUI
import MapleCore

#Preview("Loaded — Info tab") {
    DetailPanel(session: EditSession.preview())
        .frame(width: 320, height: 700)
}

#Preview("Loaded — full-image variant") {
    DetailPanel(session: EditSession.preview(), isFullImage: true)
        .frame(width: 320, height: 700)
}

#Preview("Empty (no session)") {
    DetailPanel(session: nil)
        .frame(width: 320, height: 700)
}
