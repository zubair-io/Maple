// TVTimelineViewModelTests.swift
//
// `TVTimelineViewModel` — the @Observable async orchestration (staleness
// guard, TVAsyncSemaphore, cache-first flow) — lives at
// `src/apple/Maple TV/TVTimelineViewModel.swift`. That file is compiled
// ONLY by the Xcode `Maple TV` app target via a
// PBXFileSystemSynchronizedRootGroup; it is not part of any SwiftPM
// target, and Maple TV has no dedicated Xcode unit-test bundle (the
// generator's `Maple TVTests` stub was removed as unused scaffolding —
// see commit eceadabeef "remove unused Maple TV test-target scaffold
// stubs"). So `swift test` cannot `@testable import` it directly.
//
// The day-grouping algorithm itself, however, is pure Foundation logic
// with no app-target dependency, so it was hoisted into
// `MapleCloudKit/Cloud/TimelineGrouping.swift` (`TimelineDay` +
// `groupByDay(_:calendar:)`, both `public`) precisely so this test can
// cover the REAL production function via `@testable import
// MapleCloudKit` instead of a hand-maintained mirror (D3 review — a copy
// only verifies the copy, and the two can drift silently).
// `TVTimelineViewModel.recomputeDays()` calls that same kit function.
//
// `GenerationGuardedLoaderSpec` below is still a deliberate, narrow
// mirror: it reproduces the exact `generation &+= 1; let g = generation;
// await …; guard g == generation else { return }` shape every
// staleness-guarded loader in this codebase uses (SearchViewModel,
// CloudTimelineViewModel, and TVTimelineViewModel.load()/loadMonth()).
// That orchestration is genuinely inseparable from the `@Observable`
// app-target class — it isn't pure data-in/data-out like grouping was —
// so it stays a mirror. If the guard shape in TVTimelineViewModel.swift
// changes, mirror the change here too. Worth a follow-up ticket: either
// a dedicated Maple TV Xcode test target, or a lightweight way to drive
// the app-target class itself from SwiftPM.

import XCTest
@testable import MapleCloudKit

@MainActor
final class TVTimelineViewModelTests: XCTestCase {

  // MARK: - Day grouping (real production function)

  func test_groupByDay_ordersDaysDescendingAcrossMonths() {
    let dayA = makeAsset(id: "a1", capturedAt: "2026-07-15T10:00:00Z")
    let dayB = makeAsset(id: "b1", capturedAt: "2026-06-02T08:00:00Z")
    let dayC = makeAsset(id: "c1", capturedAt: "2026-06-01T23:59:00Z")

    // Fed out of order — the function must sort, not trust input order.
    let days = groupByDay([dayC, dayA, dayB], calendar: utcCalendar)

    XCTAssertEqual(days.map { $0.assets.map(\.id) }, [["a1"], ["b1"], ["c1"]],
      "days must be ordered newest-first, independent of input order")
  }

  func test_groupByDay_sortsAssetsWithinADayNewestFirst() {
    let earliest = makeAsset(id: "earliest", capturedAt: "2026-07-15T08:00:00Z")
    let middle = makeAsset(id: "middle", capturedAt: "2026-07-15T14:00:00Z")
    let latest = makeAsset(id: "latest", capturedAt: "2026-07-15T20:00:00Z")

    let days = groupByDay([earliest, latest, middle], calendar: utcCalendar)

    XCTAssertEqual(days.count, 1)
    XCTAssertEqual(days[0].assets.map(\.id), ["latest", "middle", "earliest"])
  }

  func test_groupByDay_placeCarriedFromFirstAssetWithPlace_notNecessarilyNewest() {
    let place = SearchAssetPlace(display_name: "Paris, France")
    // Newest asset in the day has NO place; an older one does — the day
    // header must still pick up the older one's place.
    let newestNoPlace = makeAsset(id: "newest", capturedAt: "2026-07-15T20:00:00Z", place: nil)
    let olderWithPlace = makeAsset(id: "older", capturedAt: "2026-07-15T08:00:00Z", place: place)

    let days = groupByDay([newestNoPlace, olderWithPlace], calendar: utcCalendar)

    XCTAssertEqual(days.count, 1)
    XCTAssertEqual(days[0].place, place,
      "the day's place must come from the first asset (newest-first) that HAS one, not literally the newest asset")
  }

  func test_groupByDay_dayWithNoGeocodedAssets_hasNilPlace() {
    let a = makeAsset(id: "a", capturedAt: "2026-07-15T10:00:00Z", place: nil)
    let b = makeAsset(id: "b", capturedAt: "2026-07-15T12:00:00Z", place: nil)

    let days = groupByDay([a, b], calendar: utcCalendar)

    XCTAssertEqual(days.count, 1)
    XCTAssertNil(days[0].place)
  }

  func test_groupByDay_dropsAssetsWithMissingOrUnparsableCapturedAt() {
    let valid = makeAsset(id: "valid", capturedAt: "2026-07-15T10:00:00Z")
    let missing = makeAsset(id: "missing", capturedAt: nil)
    let unparsable = makeAsset(id: "unparsable", capturedAt: "not-a-date")

    let days = groupByDay([valid, missing, unparsable], calendar: utcCalendar)

    XCTAssertEqual(days.count, 1)
    XCTAssertEqual(days[0].assets.map(\.id), ["valid"],
      "assets with a missing/unparsable captured_at must be dropped, not crash or produce a section")
  }

  func test_groupByDay_emptyInput_producesNoSections() {
    XCTAssertTrue(groupByDay([], calendar: utcCalendar).isEmpty)
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
