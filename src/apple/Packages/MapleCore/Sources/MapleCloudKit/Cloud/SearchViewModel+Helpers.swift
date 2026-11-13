// SearchViewModel+Helpers.swift
//
// Pure helpers of `SearchViewModel`, kept beside it so the view model stays
// inside the file-size budget.

import Foundation

extension SearchViewModel {
  /// The server's window ladder (`windowDepthFor`): the first step whose quota reaches `need` rows.
  nonisolated static func windowStep(reaching need: Int) -> Int {
    let ladder = RankedWindowLadder.self
    let reaching = sequence(first: ladder.base) { $0 * ladder.wideningFactor }
      .first { $0 * ladder.stepQuotaPercent / 100 >= need || $0 >= ladder.max }
    return min(reaching ?? ladder.max, ladder.max)
  }
}
