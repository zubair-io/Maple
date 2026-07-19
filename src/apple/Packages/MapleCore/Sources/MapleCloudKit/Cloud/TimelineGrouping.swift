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
      .flatMap { parseTimelineISO8601($0) }
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

/// Process-wide ISO 8601 formatters — documented thread-safe, and shared
/// so grouping a month's worth of assets doesn't allocate one per asset
/// (matches the `iso8601` pattern in `CloudTimelineViewModel`). Two
/// formatters, tried in order, because `ISO8601DateFormatter` matches its
/// `formatOptions` exactly — one instance can't parse both shapes:
///
///  - The server's real `captured_at` values are Mongo `Date`s serialized
///    via JS `toISOString()`, which always emits millisecond precision
///    (`"2022-09-10T11:32:07.000Z"`) — that needs `.withFractionalSeconds`.
///  - Some inputs (older fixtures, hand-written data) omit the fractional
///    component (`"2022-09-10T11:32:07Z"`) — that needs it OMITTED, since
///    `.withFractionalSeconds` rejects a string with no fractional part.
///
/// A single formatter without `.withFractionalSeconds` (the original bug)
/// silently rejected every real server timestamp: `date(from:)` returned
/// `nil` for every asset, `groupByDay`'s `compactMap` dropped all of them,
/// and the Timeline rendered "No photos yet" against a library with real,
/// correctly-indexed photos. Caught via D7 live E2E verification against
/// the real API — every unit-test fixture in `TVTimelineViewModelTests`
/// used a fractional-second-free string (`"2026-07-15T10:00:00Z"`), which
/// the buggy formatter parsed fine, so the bug was invisible to `swift test`.
private let timelineGroupingISO8601Fractional: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()
private let timelineGroupingISO8601Whole: ISO8601DateFormatter = ISO8601DateFormatter()

/// Parses a `captured_at` wire value from the server, trying the
/// fractional-seconds shape first (what the server actually emits) and
/// falling back to the whole-seconds shape (older fixtures / hand-written
/// data). Shared by every Maple TV call site that needs to turn
/// `SearchAsset.captured_at` back into a `Date` for display —
/// `TimelineCell` and `PhotoViewerScreen` both call this instead of
/// keeping their own formatter, so the fractional-seconds fix (and any
/// future format change) lives in exactly one place.
public func parseTimelineISO8601(_ isoString: String) -> Date? {
  timelineGroupingISO8601Fractional.date(from: isoString)
    ?? timelineGroupingISO8601Whole.date(from: isoString)
}
