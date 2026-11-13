import Foundation
import XCTest

@testable import MapleCloudKit
@testable import MapleCore

@MainActor
final class FolderTrashForYouCacheTests: XCTestCase {
  private let host = "example.test"
  private let library = "library"
  private var directory: URL!

  override func setUp() async throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("folder-trash-\(UUID().uuidString)", isDirectory: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: directory)
  }

  func testPartialTrashForgetsOnlySuccessfulAssetCovers() async throws {
    let cache = ForYouCache(directory: directory)
    await cache.write(try snapshot(), libraryID: library, host: host)

    await cache.forgetFolderTrash(
      try summary(failed: 1), host: host, libraryFolderID: library, folderPath: "/photos/trip")

    let stored = await cache.read(libraryID: library, host: host)
    XCTAssertEqual(Set(stored?.firstPages.keys.map { $0 } ?? []), ["failed"])
    XCTAssertEqual(stored?.firstPages["failed"]?.results.first?.id, "failed-id")
  }

  func testCompleteTrashForgetsAllFolderCovers() async throws {
    let cache = ForYouCache(directory: directory)
    await cache.write(try snapshot(), libraryID: library, host: host)

    await cache.forgetFolderTrash(
      try summary(failed: 0), host: host, libraryFolderID: library, folderPath: "/photos/trip")

    let stored = await cache.read(libraryID: library, host: host)
    XCTAssertEqual(stored?.firstPages.isEmpty, true)
  }

  func testPartialTrashPrunesMixedPagesOnceAndKeepsFailedCover() async throws {
    let cache = ForYouCache(directory: directory)
    let successfulIDs = (1..<30).map { "success-\($0)" }
    let results = try [asset(id: "failed-id")] + successfulIDs.map { try asset(id: $0) }
    let page = GeneratedSearchAssetPage(results: results, total: 100, isSnapshot: true)
    let livePage = GeneratedSearchAssetPage(results: results, total: 100, more: true)
    let card = GeneratedSearchCard(
      id: "mixed", theme: "t", title: "Mixed", result_count: results.count,
      generated_for: "2026-10-17")
    let snapshot = ForYouSnapshot(
      collections: [card], firstPages: [card.id: page], savedAt: Date())
    await cache.write(snapshot, libraryID: library, host: host)
    await cache.write(
      ForYouSnapshot(collections: [card], firstPages: [card.id: livePage], savedAt: Date()),
      libraryID: "another-library", host: host)
    let before = await cache.epoch(host: host)

    await cache.forgetFolderTrash(
      try partialSummary(successfulIDs: successfulIDs, failedID: "failed-id"), host: host,
      libraryFolderID: library, folderPath: "/photos/trip")

    for libraryID in [library, "another-library"] {
      let stored = await cache.read(libraryID: libraryID, host: host)
      XCTAssertEqual(stored?.firstPages[card.id]?.results.map(\.id), ["failed-id"])
      XCTAssertEqual(stored?.firstPages[card.id]?.total, 71)
      XCTAssertEqual(stored?.firstPages[card.id]?.isSnapshot, libraryID == library)
      XCTAssertEqual(stored?.firstPages[card.id]?.more, libraryID != library)
    }
    let after = await cache.epoch(host: host)
    XCTAssertEqual(after, before + 1, "one folder outcome is one atomic cache invalidation")
  }

  func testPartialTrashPreservesFailedAndOtherLocationOfSameDatabaseAsset() async throws {
    let cache = ForYouCache(directory: directory)
    let sharedID = "650a1b2c3d4e5f6071829301"
    let uniqueID = "650a1b2c3d4e5f6071829302"
    let card = GeneratedSearchCard(
      id: "mixed", theme: "t", title: "Mixed", result_count: 3,
      generated_for: "2026-10-17")
    let inside = [
      try locatedAsset(
        id: "failed-location", databaseID: sharedID, folder: library,
        path: "/photos/trip/failed.dng"),
      try locatedAsset(
        id: "success-location", databaseID: sharedID, folder: library,
        path: "/photos/trip/success.dng"),
      try locatedAsset(
        id: "unique-success", databaseID: uniqueID, folder: library,
        path: "/photos/trip/unique.dng"),
    ]
    let outside = [
      try locatedAsset(
        id: "other-library", databaseID: uniqueID, folder: "other-folder",
        path: "/elsewhere/unique.dng"),
      try locatedAsset(
        id: "other-path", databaseID: uniqueID, folder: library,
        path: "/photos/home/unique.dng"),
    ]
    await cache.write(
      ForYouSnapshot(
        collections: [card], firstPages: [card.id: .init(results: inside, total: 3)],
        savedAt: Date()), libraryID: library, host: host)
    await cache.write(
      ForYouSnapshot(
        collections: [card], firstPages: [card.id: .init(results: outside, total: 2)],
        savedAt: Date()), libraryID: "another-library", host: host)
    let data = try JSONSerialization.data(withJSONObject: [
      "total": 3, "succeeded": 2, "failed": 1,
      "items": [
        ["assetId": sharedID, "filename": "success.dng", "ok": true],
        ["assetId": sharedID, "filename": "failed.dng", "ok": false],
        ["assetId": uniqueID, "filename": "unique.dng", "ok": true],
      ],
    ])
    let summary = try JSONDecoder().decode(FolderTrashSummary.self, from: data)

    await cache.forgetFolderTrash(
      summary, host: host, libraryFolderID: library, folderPath: "/photos/trip")

    let keptInside = await cache.read(libraryID: library, host: host)
    let keptOutside = await cache.read(libraryID: "another-library", host: host)
    XCTAssertEqual(
      keptInside?.firstPages[card.id]?.results.map(\.id),
      ["failed-location", "success-location"])
    XCTAssertEqual(
      keptOutside?.firstPages[card.id]?.results.map(\.id),
      ["other-library", "other-path"])
  }

  private func partialSummary(successfulIDs: [String], failedID: String) throws
    -> FolderTrashSummary
  {
    let items =
      successfulIDs.map { ["assetId": $0, "filename": "\($0).dng", "ok": true] as [String: Any] }
      + [["assetId": failedID, "filename": "failed.dng", "ok": false]]
    let data = try JSONSerialization.data(withJSONObject: [
      "total": items.count, "succeeded": successfulIDs.count, "failed": 1, "items": items,
    ])
    return try JSONDecoder().decode(FolderTrashSummary.self, from: data)
  }

  private func asset(id: String) throws -> SearchAsset {
    let json = """
      {"id":"\(id)","folder_id":"\(library)","abs_path":"/photos/trip/\(id).dng","filename":"\(id).dng"}
      """
    return try JSONDecoder().decode(SearchAsset.self, from: Data(json.utf8))
  }

  private func locatedAsset(id: String, databaseID: String, folder: String, path: String) throws
    -> SearchAsset
  {
    let json = """
      {"id":"\(id)","_id":"\(databaseID)","folder_id":"\(folder)","abs_path":"\(path)","filename":"x.dng"}
      """
    return try JSONDecoder().decode(SearchAsset.self, from: Data(json.utf8))
  }

  private func summary(failed: Int) throws -> FolderTrashSummary {
    let failedItem = failed == 0 ? "true" : "false"
    let json = """
      {"total":2,"succeeded":\(2 - failed),"failed":\(failed),"items":[
        {"assetId":"success-id","filename":"success.dng","ok":true},
        {"assetId":"failed-id","filename":"failed.dng","ok":\(failedItem)}
      ]}
      """
    return try JSONDecoder().decode(FolderTrashSummary.self, from: Data(json.utf8))
  }

  private func snapshot() throws -> ForYouSnapshot {
    let cards = ["success", "failed"].map {
      GeneratedSearchCard(
        id: $0, theme: "t", title: $0, result_count: 1, generated_for: "2026-10-17")
    }
    let pages = try Dictionary(
      uniqueKeysWithValues: ["success", "failed"].map { name in
        let json = """
          {"id":"\(name)-id","folder_id":"\(library)","abs_path":"/photos/trip/\(name).dng","filename":"\(name).dng"}
          """
        let asset = try JSONDecoder().decode(SearchAsset.self, from: Data(json.utf8))
        return (name, GeneratedSearchAssetPage(results: [asset], total: 1, isSnapshot: true))
      })
    return ForYouSnapshot(collections: cards, firstPages: pages, savedAt: Date())
  }
}
