// src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderModifyItemMetadataTests.swift
import FileProvider
import XCTest

@testable import MapleFileProviderCore

/// #5456: after a bulk drop the OS follows up with `modifyItem` calls that
/// change only local metadata (dates, tags, extended attributes) on new
/// folders, videos and sidecars. Those used to fail with
/// featureUnsupported and left items badged with an upload error.
final class FileProviderModifyItemMetadataTests: XCTestCase {
  override func setUp() {
    super.setUp()
    StubURLProtocol.register()
    StubURLProtocol.reset()
  }

  override func tearDown() {
    StubURLProtocol.reset()
    super.tearDown()
  }

  private let roots = [LibraryRoot(id: "folder-1", path: "/lib", label: "Lib", fileCount: 1)]
  private let parent = NSFileProviderItemIdentifier(
    FileProviderIdentifier.folder(folderID: "folder-1", relativePath: "").rawValue)

  private func modify(
    _ core: FileProviderExtensionCore, item: FakeFileProviderItem,
    fields: NSFileProviderItemFields, contents: URL? = nil
  ) -> (item: NSFileProviderItem?, error: Error?) {
    let done = expectation(description: "modifyItem completed")
    var result: (item: NSFileProviderItem?, error: Error?) = (nil, nil)
    _ = core.modifyItem(
      item, baseVersion: item.itemVersion, changedFields: fields, contents: contents,
      options: [], request: NSFileProviderRequest(),
      completionHandler: { item, _, _, error in
        result = (item, error)
        done.fulfill()
      })
    wait(for: [done], timeout: 5)
    return result
  }

  private func item(_ identifier: FileProviderIdentifier, filename: String) -> FakeFileProviderItem
  {
    FakeFileProviderItem(
      itemIdentifier: NSFileProviderItemIdentifier(identifier.rawValue),
      parentItemIdentifier: parent, filename: filename)
  }

  func testMetadataOnlyChangesAreEchoedForEveryItemKind() {
    let log = FPCoreTestSupport.RequestLog()
    let catalog = FPCoreTestSupport.makeCatalog { req in
      log.record(req)
      return (500, Data(), [:])
    }
    let core = FPCoreTestSupport.makeCore(catalog: catalog, roots: roots, test: self)
    let metadataOnly: NSFileProviderItemFields = [
      .contentModificationDate, .creationDate, .lastUsedDate, .tagData, .extendedAttributes,
    ]
    let items = [
      item(.folder(folderID: "folder-1", relativePath: "Drop"), filename: "Drop"),
      item(.file(folderID: "folder-1", relativePath: "DJI_0001.MP4"), filename: "DJI_0001.MP4"),
      item(
        .sidecar(assetID: "650a1b2c3d4e5f6071829304", conflictBasename: nil), filename: "photo.xmp"),
      item(.asset("650a1b2c3d4e5f6071829304"), filename: "photo.ARW"),
    ]
    for candidate in items {
      let result = modify(core, item: candidate, fields: metadataOnly)
      XCTAssertNil(result.error, "\(candidate.itemIdentifier.rawValue) must not fail")
      XCTAssertIdentical(result.item, candidate)
    }
    XCTAssertTrue(log.requests.isEmpty, "local metadata never reaches the server")
  }

  func testFolderRenameWithMetadataStillRenames() {
    let log = FPCoreTestSupport.RequestLog()
    let catalog = FPCoreTestSupport.makeCatalog { req in
      log.record(req)
      if req.url?.path == "/api/folders/folder-1/move" {
        return (200, Data(#"{"abs_path":"/lib/Renamed"}"#.utf8), [:])
      }
      return (404, Data(), [:])
    }
    let core = FPCoreTestSupport.makeCore(catalog: catalog, roots: roots, test: self)
    let folder = item(.folder(folderID: "folder-1", relativePath: "Drop"), filename: "Renamed")
    let result = modify(core, item: folder, fields: [.filename, .contentModificationDate])
    XCTAssertNil(result.error)
    XCTAssertEqual(result.item?.filename, "Renamed")
    XCTAssertEqual(log.count(method: "POST"), 1, "the rename reaches the server")
  }

  func testNonIndexedFileContentChangeUploadsTheNewBytes() throws {
    let log = FPCoreTestSupport.RequestLog()
    let catalog = FPCoreTestSupport.makeCatalog { req in
      log.record(req)
      if req.url?.path == "/api/folders/folder-1/upload" {
        let body =
          #"{"asset_id":null,"abs_path":"/lib/notes.txt","size":5,"mtime":"2026-10-26T00:00:00.000Z"}"#
        return (201, Data(body.utf8), [:])
      }
      return (404, Data(), [:])
    }
    let core = FPCoreTestSupport.makeCore(catalog: catalog, roots: roots, test: self)
    let contents = FileManager.default.temporaryDirectory
      .appendingPathComponent("modify-file-\(UUID().uuidString).txt")
    try Data("hello".utf8).write(to: contents)
    addTeardownBlock { try? FileManager.default.removeItem(at: contents) }

    let file = item(.file(folderID: "folder-1", relativePath: "notes.txt"), filename: "notes.txt")
    let result = modify(
      core, item: file, fields: [.contents, .contentModificationDate], contents: contents)

    XCTAssertNil(result.error)
    XCTAssertEqual(
      result.item?.itemIdentifier.rawValue,
      FileProviderIdentifier.file(folderID: "folder-1", relativePath: "notes.txt").rawValue)
    XCTAssertEqual(log.count(method: "POST"), 1)
    XCTAssertEqual(
      log.requests.first?.headers["X-Maple-Target-Path"], "notes.txt",
      "the new bytes replace the same path")
  }

  func testAssetContentChangeStaysUnsupported() {
    let catalog = FPCoreTestSupport.makeCatalog { _ in (500, Data(), [:]) }
    let core = FPCoreTestSupport.makeCore(catalog: catalog, roots: roots, test: self)
    let raw = item(.asset("650a1b2c3d4e5f6071829304"), filename: "photo.ARW")
    let contents = FileManager.default.temporaryDirectory.appendingPathComponent(
      "raw-\(UUID().uuidString)")
    let result = modify(core, item: raw, fields: [.contents], contents: contents)
    XCTAssertEqual((result.error as NSError?)?.code, NSFeatureUnsupportedError)
  }
}
