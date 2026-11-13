// SearchViewModel+Helpers.swift
//
// Pure helpers of `SearchViewModel`, kept beside it so the view model stays
// inside the file-size budget.

import Foundation

extension SearchViewModel {
  /// Facet rows for the filter panel's PEOPLE section ([] until the first
  /// facets response, or on servers predating the field).
  public var peopleFacets: [ValueFacet] { facets?.people ?? [] }

  /// Facet rows for the filter panel's PLACES section.
  public var placeFacets: [ValueFacet] { facets?.places ?? [] }

  /// Live "Show N results" count for the current filter set — the facets
  /// total when one is loaded, else the result-list total.
  public var facetTotal: Int { facets?.total ?? total }
  /// Which matches the facet rows count (#4431); `.all` until facets load.
  public var facetScope: FacetScope { facets?.scope ?? .all }

  /// The server's window ladder (`windowDepthFor`): the first step whose quota reaches `need` rows.
  nonisolated static func windowStep(reaching need: Int) -> Int {
    let ladder = RankedWindowLadder.self
    let reaching = sequence(first: ladder.base) { $0 * ladder.wideningFactor }
      .first { $0 * ladder.stepQuotaPercent / 100 >= need || $0 >= ladder.max }
    return min(reaching ?? ladder.max, ladder.max)
  }
}
