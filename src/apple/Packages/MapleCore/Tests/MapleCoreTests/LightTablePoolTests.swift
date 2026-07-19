// LightTablePoolTests.swift
//
// `mergeDeduped` (MapleCloudKit/Cloud/LightTablePool.swift) is the pure
// half of the Maple TV Light Table's source-pool selection (#2121 F2) —
// see that file's header for why the async fetch orchestration stays in
// the app-target `LightTableViewModel` while this piece is hoisted for
// direct `swift test` coverage.

import XCTest
@testable import MapleCloudKit

final class LightTablePoolTests: XCTestCase {

  func test_mergeDeduped_unionsListsPreservingOrder() {
    let a = makeAsset(id: "a")
    let b = makeAsset(id: "b")
    let c = makeAsset(id: "c")

    let merged = mergeDeduped([a, b], [c])

    XCTAssertEqual(merged.map(\.id), ["a", "b", "c"],
      "each list's own order must be preserved, earlier lists first")
  }

  func test_mergeDeduped_dropsDuplicateAcrossLists_keepingFirstOccurrence() {
    // Same asset id from two different queries (e.g. a pick that's ALSO
    // rated >=4) — must appear exactly once, sourced from the first list.
    let pickCopy = makeAsset(id: "shared", filename: "from-picks.dng")
    let highRatedCopy = makeAsset(id: "shared", filename: "from-high-rated.dng")

    let merged = mergeDeduped([pickCopy], [highRatedCopy])

    XCTAssertEqual(merged.count, 1)
    XCTAssertEqual(merged.first?.filename, "from-picks.dng",
      "the first list's copy must win — later lists only contribute NEW ids")
  }

  func test_mergeDeduped_dropsDuplicatesWithinASingleList() {
    let a = makeAsset(id: "a")
    let aAgain = makeAsset(id: "a", filename: "renamed.dng")

    let merged = mergeDeduped([a, aAgain])

    XCTAssertEqual(merged.map(\.id), ["a"])
  }

  func test_mergeDeduped_threeLists_picksHighRatedRecent_dedupesAcrossAll() {
    // Mirrors LightTableViewModel.load()'s real shape: picks, then
    // high-rated, then a recent fallback — with overlap at every seam.
    let picks = [makeAsset(id: "p1"), makeAsset(id: "shared-ph")]
    let highRated = [makeAsset(id: "shared-ph"), makeAsset(id: "h1")]
    let recent = [makeAsset(id: "h1"), makeAsset(id: "r1")]

    let primary = mergeDeduped(picks, highRated)
    let withFallback = mergeDeduped(primary, recent)

    XCTAssertEqual(primary.map(\.id), ["p1", "shared-ph", "h1"])
    XCTAssertEqual(withFallback.map(\.id), ["p1", "shared-ph", "h1", "r1"])
  }

  func test_mergeDeduped_emptyListsProduceEmptyResult() {
    XCTAssertTrue(mergeDeduped([SearchAsset](), [SearchAsset]()).isEmpty)
    XCTAssertTrue(mergeDeduped().isEmpty)
  }

  // MARK: - Fixtures

  private func makeAsset(id: String, filename: String? = nil) -> SearchAsset {
    SearchAsset(id: id, folder_id: "lib-test",
                abs_path: "/photos/\(id).dng", filename: filename ?? "\(id).dng")
  }
}
