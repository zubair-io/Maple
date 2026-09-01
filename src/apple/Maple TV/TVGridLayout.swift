// src/apple/Maple TV/TVGridLayout.swift
//
// Column math for the tvOS walls (Timeline photos, Memories cards).
//
// `GridItem(.adaptive(...))` is the wrong tool for these: it packs as many
// columns as fit at the given width and then leaves whatever is left over
// hanging off the trailing edge, so the wall reads as left-packed with a
// ragged margin down one side. Here the cell width is *derived* instead —
// pick the column count from a target size, then stretch the cells to
// consume the row exactly. That gives the two properties a wall on a
// television needs: the outer margins are equal (both exactly
// `horizontalInset`) and every gap between cells is exactly `spacing`.

import SwiftUI

struct TVGridLayout {
  /// How many columns fit.
  let columns: Int
  /// The width each cell must be for `columns` of them, plus their gaps, to
  /// span the content width exactly.
  let cellWidth: CGFloat
  /// Gap between adjacent cells, horizontally.
  let spacing: CGFloat

  init(
    containerWidth: CGFloat,
    targetCellWidth: CGFloat,
    spacing: CGFloat,
    horizontalInset: CGFloat
  ) {
    let usable = containerWidth - horizontalInset * 2
    // A container narrower than one target cell — including the zero-width
    // first layout pass — still gets a single, non-degenerate column.
    let fitted = usable >= targetCellWidth
      ? max(1, Int((usable + spacing) / (targetCellWidth + spacing)))
      : 1
    self.columns = fitted
    self.cellWidth = max(1, (usable - spacing * CGFloat(fitted - 1)) / CGFloat(fitted))
    self.spacing = spacing
  }

  /// `LazyVGrid` columns for this layout. Fixed rather than flexible so the
  /// cells sit on an even pitch instead of being re-proportioned per row.
  var gridItems: [GridItem] {
    Array(repeating: GridItem(.fixed(cellWidth), spacing: spacing), count: columns)
  }
}
