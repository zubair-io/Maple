// FlowLayout.swift — wrap-on-overflow horizontal layout, shared by the S6
// Info pane's chip groups (`EnrichmentSubBlocks`'s Vision/Faces chip
// groups). Split out of `KeywordChipsRow.swift` when that file's own chip
// row moved onto MapleUI's `MuiKeywordRow` (Maple UI adoption epic #3019,
// wave MA3) — `EnrichmentSubBlocks` still needs the wrap layout for its
// read-only enrichment chip groups, which stayed hand-rolled (no matching
// read-only Mui composition exists yet for that surface).
//
// SwiftUI doesn't ship a built-in flow / "wrap" stack; this is the minimum
// viable Layout implementation — measure each subview at its ideal size,
// place left-to-right, wrap when the next item would exceed
// `proposal.width`.

import SwiftUI

struct FlowLayout: Layout {
  var spacing: CGFloat = 6

  func sizeThatFits(
    proposal: ProposedViewSize,
    subviews: Subviews,
    cache: inout Void
  ) -> CGSize {
    let width = proposal.width ?? .infinity
    var rowWidth: CGFloat = 0
    var rowHeight: CGFloat = 0
    var totalHeight: CGFloat = 0
    var maxWidth: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if rowWidth + size.width > width && rowWidth > 0 {
        totalHeight += rowHeight + spacing
        maxWidth = max(maxWidth, rowWidth - spacing)
        rowWidth = 0
        rowHeight = 0
      }
      rowWidth += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
    totalHeight += rowHeight
    maxWidth = max(maxWidth, rowWidth - spacing)
    return CGSize(width: max(0, maxWidth), height: totalHeight)
  }

  func placeSubviews(
    in bounds: CGRect,
    proposal: ProposedViewSize,
    subviews: Subviews,
    cache: inout Void
  ) {
    let width = bounds.width
    var x = bounds.minX
    var y = bounds.minY
    var rowHeight: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x + size.width > bounds.minX + width && x > bounds.minX {
        x = bounds.minX
        y += rowHeight + spacing
        rowHeight = 0
      }
      subview.place(
        at: CGPoint(x: x, y: y),
        anchor: .topLeading,
        proposal: ProposedViewSize(size)
      )
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
  }
}
