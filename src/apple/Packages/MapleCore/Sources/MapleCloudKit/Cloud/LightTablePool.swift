// LightTablePool.swift
//
// Pure merge-dedup helper for the Maple TV Light Table's ambient source
// pool (#2121 F2). Mirrors the reasoning in TimelineGrouping.swift's
// header exactly: the orchestration that FETCHES the candidate lists
// (`CloudSearchClient.search`, one query for `flag=pick`, one for
// `rating>=4`, and a `captured_desc` fallback when those two are thin)
// is async/network code that lives in the app target
// (`Maple TV/LightTableViewModel.swift`, which the SwiftPM test target
// can't `@testable import` — no dedicated Xcode test bundle exists for
// Maple TV, see `TVTimelineViewModelTests.swift`'s header for the same
// situation). The SELECTION policy over already-fetched lists, though,
// is pure data-in/data-out and belongs where `swift test` can exercise
// the real function instead of a hand-maintained mirror.

import Foundation

/// Order-preserving union of `lists`, deduplicated by `SearchAsset.id`.
/// An asset already seen in an earlier list is skipped when it recurs in
/// a later one — so `mergeDeduped(picks, highRated)` keeps every pick,
/// then appends only the high-rated assets that AREN'T also a pick (an
/// asset that's both flagged pick and rated ≥4 counts once, sourced from
/// `picks`). `LightTableViewModel.load()` calls this twice: once to
/// combine the picks/high-rated queries, and again — only when that
/// result is thinner than its minimum pool size — to layer in a
/// `captured_desc` recent-assets fallback.
public func mergeDeduped(_ lists: [SearchAsset]...) -> [SearchAsset] {
  var seenIDs = Set<String>()
  return lists.flatMap { $0 }.filter { seenIDs.insert($0.id).inserted }
}

/// Round-robin flatten: one from each list, then the next from each, until
/// every list is spent. Empty and short lists are simply skipped once
/// exhausted, so lists of wildly different lengths are handled without
/// padding.
///
/// The Light Table uses this on the day's Memories, where each list is one
/// memory's photos. Concatenating instead would put every photo of the
/// largest memory ahead of every photo of the others, and since the pool is
/// later truncated by nothing but a shuffle, a lopsided day would still bias
/// which memories are represented at all. Round-robin gives each memory an
/// even footing before the shuffle.
public func interleaved(_ lists: [[SearchAsset]]) -> [SearchAsset] {
  let longest = lists.map(\.count).max() ?? 0
  return (0..<longest).flatMap { index in
    lists.compactMap { index < $0.count ? $0[index] : nil }
  }
}
