// TopShelfBuilderTests.swift
//
// The Top Shelf's selection policy: which content becomes carousel entries.
// See `TopShelfCacheTests`' header for why this lives here rather than in a
// Maple TV test bundle.

import XCTest

@testable import MapleCloudKit

final class TopShelfBuilderTests: XCTestCase {

  // MARK: - Memories

  func test_memories_becomeEntriesInOrderWithAPhotoCount() {
    let collections = [
      card(id: "a", title: "Spooky Nights", count: 12),
      card(id: "b", title: "Lake George", count: 1),
    ]
    let covers = ["a": asset(id: "cover-a"), "b": asset(id: "cover-b")]

    let entries = TopShelfBuilder.entries(forMemories: collections, covers: covers)

    XCTAssertEqual(entries.map(\.id), ["a", "b"])
    XCTAssertEqual(entries.map(\.title), ["Spooky Nights", "Lake George"])
    XCTAssertEqual(
      entries.map(\.subtitle), ["12 photos", "1 photo"],
      "a single photo must not read as \"1 photos\"")
  }

  func test_memories_withoutACoverAreDroppedRatherThanShownBlank() {
    let collections = [
      card(id: "a", title: "Has cover", count: 3),
      card(id: "b", title: "No cover", count: 4),
    ]

    let entries = TopShelfBuilder.entries(forMemories: collections, covers: ["a": asset(id: "c")])

    // The Top Shelf is a Home-screen surface nobody opted into looking at: a
    // grey placeholder there reads as the app being broken, one fewer memory
    // reads as nothing at all.
    XCTAssertEqual(entries.map(\.id), ["a"])
  }

  func test_memories_areCappedAtTheLimit() {
    let collections = (0..<10).map { card(id: "c\($0)", title: "T\($0)", count: 1) }
    let covers = Dictionary(uniqueKeysWithValues: collections.map { ($0.id, asset(id: $0.id)) })

    let entries = TopShelfBuilder.entries(forMemories: collections, covers: covers, limit: 3)

    XCTAssertEqual(entries.count, 3)
  }

  func test_memories_produceNothingWhenThereAreNone() {
    XCTAssertTrue(TopShelfBuilder.entries(forMemories: [], covers: [:]).isEmpty)
  }

  // MARK: - Recents fallback

  func test_recents_becomeEntriesTitledByFilename() {
    let assets = [asset(id: "1", filename: "IMG_0001.DNG", capturedAt: "2026-08-15T12:00:00.000Z")]

    let entries = TopShelfBuilder.entries(forRecents: assets)

    XCTAssertEqual(entries.map(\.id), ["1"])
    XCTAssertEqual(entries.first?.title, "IMG_0001.DNG")
    XCTAssertNotNil(entries.first?.subtitle, "a parseable capture date should render")
  }

  func test_recents_toleratesFractionalSecondsAndAMissingDate() {
    // The server sends millisecond-precision `captured_at`; a bare
    // ISO8601DateFormatter drops those, which is what once left the whole
    // tvOS timeline empty.
    let withMillis = TopShelfBuilder.entries(
      forRecents: [asset(id: "1", capturedAt: "2026-08-15T12:00:00.000Z")])
    let withoutMillis = TopShelfBuilder.entries(
      forRecents: [asset(id: "2", capturedAt: "2026-08-15T12:00:00Z")])
    let undated = TopShelfBuilder.entries(forRecents: [asset(id: "3", capturedAt: nil)])

    XCTAssertNotNil(withMillis.first?.subtitle)
    XCTAssertNotNil(withoutMillis.first?.subtitle)
    XCTAssertNil(undated.first?.subtitle, "no date is a missing subtitle, not a crash")
  }

  func test_recents_areCappedAtTheLimit() {
    let assets = (0..<10).map { asset(id: "a\($0)") }

    XCTAssertEqual(TopShelfBuilder.entries(forRecents: assets, limit: 2).count, 2)
  }

  // MARK: - Fixtures

  private func card(id: String, title: String, count: Int) -> GeneratedSearchCard {
    GeneratedSearchCard(
      id: id, theme: "t", title: title, result_count: count,
      generated_for: "2026-09-02")
  }

  private func asset(
    id: String, filename: String? = nil,
    capturedAt: String? = nil
  ) -> SearchAsset {
    SearchAsset(
      id: id, folder_id: "lib", abs_path: "/photos/\(id).dng",
      filename: filename ?? "\(id).dng", captured_at: capturedAt)
  }
}
