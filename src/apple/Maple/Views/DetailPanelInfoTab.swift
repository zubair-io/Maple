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
// Reusable shared types (`InfoRow`, `SectionHeader`) also live here
// rather than in the parent file — they were Info-only helpers.

import MapleCore
import SwiftUI

// MARK: - InfoTab

struct InfoTab: View {
  let session: EditSession?

  var body: some View {
    InfoPanelView(session: session, isInsideSheet: false)
  }
}

// MARK: - InfoRow

/// Kept available for any callers that still render an ad-hoc info row
/// outside `InfoPanelView`. Not used by the S6 panel itself, which
/// renders rows via `CameraLocationGrid.KVRow` with its own layout.
struct InfoRow: View {
  let label: String
  let value: String

  init(_ label: String, _ value: String) {
    self.label = label
    self.value = value
  }

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Text(label)
        .font(MapleTokens.Typography.body)
        .foregroundStyle(MapleTokens.textMuted)
        .frame(width: 96, alignment: .trailing)
      Text(value)
        .font(MapleTokens.Typography.rowLabel)
        .foregroundStyle(MapleTokens.textMain)
        .frame(maxWidth: .infinity, alignment: .leading)
        .lineLimit(3)
        .textSelection(.enabled)
    }
    .padding(.horizontal, MapleTokens.Spacing.panelInset)
    .padding(.vertical, 4)
  }
}

// MARK: - SectionHeader

/// Shared eyebrow section header — used by the Develop tab's
/// `CollapsibleSection`. Kept here (vs the parent file) because it's
/// most heavily used by Info-shaped layouts.
struct SectionHeader: View {
  let title: String
  init(_ title: String) { self.title = title }

  var body: some View {
    Text(title.uppercased())
      .font(MapleTokens.Typography.eyebrow)
      .foregroundStyle(MapleTokens.textMuted)
      .tracking(1.4)
      .padding(.horizontal, MapleTokens.Spacing.panelInset)
      .padding(.bottom, 4)
  }
}
