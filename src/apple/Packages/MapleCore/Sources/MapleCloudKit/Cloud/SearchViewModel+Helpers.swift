// SearchViewModel+Helpers.swift
//
// Pure helpers of `SearchViewModel`, kept beside it so the view model stays
// inside the file-size budget.

import Foundation

extension SearchViewModel {
  /// The server's window ladder (`windowDepthFor`): the first step reaching `need` rows.
  nonisolated static func windowStep(reaching need: Int) -> Int {
    let ladder = RankedWindowLadder.self
    let reaching = sequence(first: ladder.base) { $0 * ladder.wideningFactor }
      .first { $0 >= need || $0 >= ladder.max }
    return min(reaching ?? ladder.max, ladder.max)
  }

  /// True when `error` is a request/task cancellation (debounce superseded
  /// this search) rather than a genuine network/decode failure.
  nonisolated static func isCancellation(_ error: Error) -> Bool {
    if error is CancellationError { return true }
    if let urlError = error as? URLError, urlError.code == .cancelled { return true }
    let ns = error as NSError
    return ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled
  }
}
