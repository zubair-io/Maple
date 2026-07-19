// TVTimelineViewModelTests.swift
//
// `TVTimelineViewModel` — the pure day-grouping algorithm and the
// generation-counter staleness guard its async loads use — lives at
// `src/apple/Maple TV/TVTimelineViewModel.swift`. That file is compiled
// ONLY by the Xcode `Maple TV` app target via a
// PBXFileSystemSynchronizedRootGroup; it is not part of any SwiftPM
// target, and Maple TV has no dedicated Xcode unit-test bundle (the
// generator's `Maple TVTests` stub was removed as unused scaffolding —
// see commit eceadabeef "remove unused Maple TV test-target scaffold
// stubs"). So `swift test` cannot `@testable import` it directly.
//
// This file gives the ALGORITHM real `swift test` coverage anyway via a
// deliberate, narrow mirror: `TimelineGroupingSpec.groupByDay` below is a
// line-for-line copy of `TVTimelineViewModel.groupByDay(_:calendar:)`,
// and `GenerationGuardedLoaderSpec` reproduces the exact
// `generation &+= 1; let g = generation; await …; guard g == generation
// else { return }` shape every staleness-guarded loader in this codebase
// uses (SearchViewModel, CloudTimelineViewModel, and
// TVTimelineViewModel.load()/loadMonth()). If the grouping algorithm or
// the guard shape in TVTimelineViewModel.swift changes, mirror the change
// here too — this is a workaround for the Maple-TV-app-target / SwiftPM
// boundary, not a design endorsement. Worth a follow-up ticket: either a
// dedicated Maple TV Xcode test target, or hoisting Maple TV's pure
// domain logic into a small local SPM package the app target links.

import XCTest
@testable import MapleCloudKit

@MainActor
final class TVTimelineViewModelTests: XCTestCase {

  // MARK: - Day grouping

  func test_groupByDay_ordersDaysDescendingAcrossMonths() {
    let dayA = makeAsset(id: "a1", capturedAt: "2026-07-15T10:00:00Z")
    let dayB = makeAsset(id: "b1", capturedAt: "2026-06-02T08:00:00Z")
    let dayC = makeAsset(id: "c1", capturedAt: "2026-06-01T23:59:00Z")

    // Fed out of order — the function must sort, not trust input order.
    let days = TimelineGroupingSpec.groupByDay([dayC, dayA, dayB], calendar: utcCalendar)

    XCTAssertEqual(days.map { $0.assetIDs }, [["a1"], ["b1"], ["c1"]],
      "days must be ordered newest-first, independent of input order")
  }

  func test_groupByDay_sortsAssetsWithinADayNewestFirst() {
    let earliest = makeAsset(id: "earliest", capturedAt: "2026-07-15T08:00:00Z")
    let middle = makeAsset(id: "middle", capturedAt: "2026-07-15T14:00:00Z")
    let latest = makeAsset(id: "latest", capturedAt: "2026-07-15T20:00:00Z")

    let days = TimelineGroupingSpec.groupByDay([earliest, latest, middle], calendar: utcCalendar)

    XCTAssertEqual(days.count, 1)
    XCTAssertEqual(days[0].assetIDs, ["latest", "middle", "earliest"])
  }

  func test_groupByDay_placeCarriedFromFirstAssetWithPlace_notNecessarilyNewest() {
    let place = SearchAssetPlace(display_name: "Paris, France")
    // Newest asset in the day has NO place; an older one does — the day
    // header must still pick up the older one's place.
    let newestNoPlace = makeAsset(id: "newest", capturedAt: "2026-07-15T20:00:00Z", place: nil)
    let olderWithPlace = makeAsset(id: "older", capturedAt: "2026-07-15T08:00:00Z", place: place)

    let days = TimelineGroupingSpec.groupByDay([newestNoPlace, olderWithPlace], calendar: utcCalendar)

    XCTAssertEqual(days.count, 1)
    XCTAssertEqual(days[0].place, place,
      "the day's place must come from the first asset (newest-first) that HAS one, not literally the newest asset")
  }

  func test_groupByDay_dayWithNoGeocodedAssets_hasNilPlace() {
    let a = makeAsset(id: "a", capturedAt: "2026-07-15T10:00:00Z", place: nil)
    let b = makeAsset(id: "b", capturedAt: "2026-07-15T12:00:00Z", place: nil)

    let days = TimelineGroupingSpec.groupByDay([a, b], calendar: utcCalendar)

    XCTAssertEqual(days.count, 1)
    XCTAssertNil(days[0].place)
  }

  func test_groupByDay_dropsAssetsWithMissingOrUnparsableCapturedAt() {
    let valid = makeAsset(id: "valid", capturedAt: "2026-07-15T10:00:00Z")
    let missing = makeAsset(id: "missing", capturedAt: nil)
    let unparsable = makeAsset(id: "unparsable", capturedAt: "not-a-date")

    let days = TimelineGroupingSpec.groupByDay([valid, missing, unparsable], calendar: utcCalendar)

    XCTAssertEqual(days.count, 1)
    XCTAssertEqual(days[0].assetIDs, ["valid"],
      "assets with a missing/unparsable captured_at must be dropped, not crash or produce a section")
  }

  func test_groupByDay_emptyInput_producesNoSections() {
    XCTAssertTrue(TimelineGroupingSpec.groupByDay([], calendar: utcCalendar).isEmpty)
  }

  // MARK: - Staleness guard

  /// Mirrors the scenario "a stale load()'s results are dropped": a first
  /// load starts (bumping the generation), a second load starts and
  /// completes BEFORE the first one's in-flight work resolves, and only
  /// the second (newer-generation) result must be applied.
  func test_staleGeneration_dropsOlderLoadResult() async {
    let loader = GenerationGuardedLoaderSpec()
    let gate = Gate()

    let firstTask = Task {
      await loader.load(tag: 1) {
        await gate.signalReady()
        await gate.waitForRelease()
      }
    }

    // Deterministically wait for the first load to have bumped its
    // generation and suspended — no sleeps, no timing races.
    await gate.waitUntilReady()

    // Second load resolves immediately: generation advances past the
    // first load's captured value.
    await loader.load(tag: 2, resolve: {})

    // Now let the stale first load's resolve() return.
    await gate.release()
    _ = await firstTask.value

    XCTAssertEqual(loader.appliedTag, 2,
      "the stale first load must not overwrite the newer result")
  }

  func test_freshGeneration_appliesLatestNonOverlappingLoad() async {
    let loader = GenerationGuardedLoaderSpec()
    await loader.load(tag: 1, resolve: {})
    await loader.load(tag: 2, resolve: {})
    XCTAssertEqual(loader.appliedTag, 2)
  }

  // MARK: - Fixtures

  /// UTC-fixed calendar so day-boundary assertions don't depend on the
  /// machine's local time zone.
  private var utcCalendar: Calendar {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    return cal
  }

  private func makeAsset(id: String, capturedAt: String?, place: SearchAssetPlace? = nil) -> SearchAsset {
    SearchAsset(id: id, folder_id: "lib-test",
                abs_path: "/photos/\(id).dng", filename: "\(id).dng",
                captured_at: capturedAt, place: place)
  }
}

// MARK: - Mirror of TVTimelineViewModel.TimelineDay / groupByDay(_:calendar:)
//
// Line-for-line copy of the production algorithm in
// `Maple TV/TVTimelineViewModel.swift`. See the file header above for why
// this duplication exists. `TimelineDaySpec` carries `assetIDs` instead of
// the full `[SearchAsset]` the production `TimelineDay` does — enough to
// assert grouping/ordering without repeating `SearchAsset`'s `Equatable`
// surface here.

private struct TimelineDaySpec: Equatable {
  let date: Date
  let assetIDs: [String]
  let place: SearchAssetPlace?
}

private enum TimelineGroupingSpec {
  static func groupByDay(_ assets: [SearchAsset], calendar: Calendar) -> [TimelineDaySpec] {
    let dated: [(asset: SearchAsset, capturedAt: Date)] = assets.compactMap { asset in
      asset.captured_at
        .flatMap { iso8601.date(from: $0) }
        .map { (asset, $0) }
    }
    let byDay = Dictionary(grouping: dated) { calendar.startOfDay(for: $0.capturedAt) }
    return byDay
      .map { day, entries -> TimelineDaySpec in
        let sorted = entries.sorted { $0.capturedAt > $1.capturedAt }
        let place = sorted.first(where: { $0.asset.place != nil })?.asset.place
        return TimelineDaySpec(date: day, assetIDs: sorted.map(\.asset.id), place: place)
      }
      .sorted { $0.date > $1.date }
  }

  private static let iso8601 = ISO8601DateFormatter()
}

// MARK: - Mirror of the generation-counter staleness guard
//
// Reproduces the exact shape `TVTimelineViewModel.load()`/`loadMonth(...)`
// use (itself mirrored from `SearchViewModel`): bump `generation` before
// any `await`, then only apply the result if nothing newer started in the
// meantime. `resolve` stands in for the network/cache round-trip so the
// race can be driven deterministically instead of depending on real
// timing.

@MainActor
private final class GenerationGuardedLoaderSpec {
  private(set) var appliedTag: Int?
  private var generation = 0

  func load(tag: Int, resolve: () async -> Void) async {
    generation &+= 1
    let g = generation
    await resolve()
    guard g == generation else { return }
    appliedTag = tag
  }
}

/// Two-phase rendezvous so a test can deterministically prove "load #1
/// started (and is suspended) before load #2 starts and finishes" with no
/// sleeps and no timing races.
private actor Gate {
  private var isReady = false
  private var isReleased = false
  private var readyContinuation: CheckedContinuation<Void, Never>?
  private var releaseContinuation: CheckedContinuation<Void, Never>?

  func waitUntilReady() async {
    if isReady { return }
    await withCheckedContinuation { readyContinuation = $0 }
  }

  func signalReady() {
    isReady = true
    readyContinuation?.resume()
    readyContinuation = nil
  }

  func waitForRelease() async {
    if isReleased { return }
    await withCheckedContinuation { releaseContinuation = $0 }
  }

  func release() {
    isReleased = true
    releaseContinuation?.resume()
    releaseContinuation = nil
  }
}
