// KeywordChipsRow.swift — S6 Info content, section 4.
//
// Thin adapter around MapleUI's `MuiKeywordRow` molecule (Maple UI
// adoption epic #3019, wave MA3). The row reads the live
// `culling.keywords` list off the EditSession and mutates it through
// `setKeywords(_:)`, which routes through `culling.didSet` → the existing
// 750ms-debounced `XMPSidecarStore.update` write. There's no separate
// render kick because keywords have zero pixel impact.
//
// `MuiKeywordRow` composes a removable chip row plus an always-visible
// trailing add-input — replacing the previous toggle-a-dashed-"+"-chip
// pattern with an inline field that's always there. The `setKeywords`
// write-through contract is unchanged.

import MapleCore
import MapleUI
import SwiftUI

// MARK: - KeywordChipsRow

struct KeywordChipsRow: View {
  /// Live session — `nil` when no asset is focused. Render-disabled state
  /// matches `RatingFlagsRow`'s pattern so the inspector layout doesn't
  /// jump while waiting for hydration.
  let session: EditSession?

  private var keywords: [String] {
    session?.culling.keywords ?? []
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      sectionHeader("Keywords")
      MuiKeywordRow(
        keywords: keywords.map { MuiChip(id: $0, label: $0) },
        removed: removeKeyword,
        added: addKeyword
      )
    }
    .disabled(session == nil)
    .opacity(session == nil ? 0.5 : 1.0)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("info-panel-keywords")
  }

  private func addKeyword(_ keyword: String) {
    guard let session else { return }
    session.setKeywords(session.culling.keywords + [keyword])
  }

  private func removeKeyword(_ keyword: String) {
    guard let session else { return }
    session.setKeywords(session.culling.keywords.filter { $0 != keyword })
  }

  private func sectionHeader(_ title: String) -> some View {
    Text(title.uppercased())
      .font(MapleTokens.Typography.eyebrow)
      .foregroundStyle(MapleTokens.textMuted)
      .tracking(1.4)
  }
}

// MARK: - Previews

#Preview("KeywordChipsRow — empty") {
  KeywordChipsRow(session: nil)
    .frame(width: 280)
    .padding()
    .background(MapleTokens.bg)
}
