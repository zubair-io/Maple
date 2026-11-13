// PanoMatcherNote.swift — The one-line "used the classical matcher" note in
// PanoMergeView's preview and result (#5487). An opted-in ML matcher that
// cannot load no longer fails the merge; this tells the user it was skipped
// and links to Settings → Pano, where it is set up.

import MapleCore
import MapleUI
import SwiftUI

struct PanoMatcherNote: View {
  let matcher: PanoMatcherOutcome
  var onOpenPanoSettings: (() -> Void)? = nil

  var body: some View {
    if let note = matcher.note {
      HStack(alignment: .top, spacing: 8) {
        MuiIcon(name: "info", size: .sm)
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
        Text(note)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("pano-matcher-note")
      if let openSettings = onOpenPanoSettings {
        Button("Set Up in Settings → Pano", action: openSettings)
          .accessibilityLabel("Open Settings → Pano to set up the ML matcher")
      }
    }
  }
}
