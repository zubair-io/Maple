// TimelineGrouping.swift
//
// Pure day-grouping algorithm for the Maple TV Timeline screen, hoisted
// into MapleCloudKit (from `Maple TV/TVTimelineViewModel.swift`) so the
// SwiftPM test target can exercise the REAL production function via
// `@testable import MapleCloudKit` instead of a hand-maintained mirror —
// see `TVTimelineViewModelTests.swift` (D3 review). Foundation-only (no
// UIKit), so it stays compatible with the `MapleCloudKitPortabilityTests`
// guard that keeps this module linkable by the Maple TV app target.

import Foundation

/// One calendar-day section of the Timeline grid.
///
/// `assets` is sorted newest-first (by `captured_at`). `place` is the
/// geocoded header for the day — the first (i.e. most recently captured)
/// asset in `assets` that has a non-nil `place`, so a day whose shots span
/// more than one location shows the most recent one; a day with no
/// geocoded assets carries `place == nil` (no header).
public struct TimelineDay: Equatable, Identifiable, Sendable {
  /// Calendar-day identity, truncated to midnight in the grouping
  /// calendar's time zone (see `groupByDay`). Two `TimelineDay`s are the
  /// same section iff this matches.
  public let date: Date
  public let assets: [SearchAsset]
  public let place: SearchAssetPlace?

  public var id: Date { date }

  public init(date: Date, assets: [SearchAsset], place: SearchAssetPlace?) {
    self.date = date
    self.assets = assets
    self.place = place
  }
}

/// Sub-group a flat list of `SearchAsset`s (as returned by
/// `CloudSearchClient.page`, typically `captured_desc` order, but this
/// function doesn't rely on that) into calendar-day sections, newest day
/// first. Assets with a missing or unparsable `captured_at` are dropped —
/// the day timeline has no section for them (the server's own
/// `hasCapturedAt=true` filter on `page()` means this is defensive, not
/// the expected path).
///
/// Each day's `place` header is the first non-nil `place` among that
/// day's assets in newest-first (`captured_at` descending) order — the
/// day's most recently captured geocoded asset wins when a day's shots
/// span more than one location.
public func groupByDay(_ assets: [SearchAsset], calendar: Calendar = .current) -> [TimelineDay] {
  let dated: [(asset: SearchAsset, capturedAt: Date)] = assets.compactMap { asset in
    asset.captured_at
      .flatMap { timelineGroupingISO8601.date(from: $0) }
      .map { (asset, $0) }
  }
  let byDay = Dictionary(grouping: dated) { calendar.startOfDay(for: $0.capturedAt) }
  return byDay
    .map { day, entries -> TimelineDay in
      let sorted = entries.sorted { $0.capturedAt > $1.capturedAt }
      let place = sorted.first(where: { $0.asset.place != nil })?.asset.place
      return TimelineDay(date: day, assets: sorted.map(\.asset), place: place)
    }
    .sorted { $0.date > $1.date }
}

/// Process-wide ISO 8601 formatter — documented thread-safe, and shared
/// so grouping a month's worth of assets doesn't allocate one per asset
/// (matches the `iso8601` pattern in `CloudTimelineViewModel`).
private let timelineGroupingISO8601: ISO8601DateFormatter = ISO8601DateFormatter()
