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
