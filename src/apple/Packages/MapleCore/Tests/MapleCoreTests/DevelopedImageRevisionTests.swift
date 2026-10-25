import CoreImage
import Observation
import XCTest

@testable import MapleCore

@MainActor
final class DevelopedImageRevisionTests: XCTestCase {
  func testEditedBytesBypassTheStableIdDecodeCache() async throws {
    let revisions = DevelopedImageRevision()
    let url = URL(fileURLWithPath: "/photos/test_0002.dng")
    let id = UUID().uuidString
    let oldBytes = try encodedImage(size: 8)
    let editedBytes = try encodedImage(size: 16)
    let originalKey = revisions.decodedKey(for: id, url: url)
    let original = await ThumbnailDecoder.image(for: oldBytes, key: originalKey)
    let stale = await ThumbnailDecoder.image(for: editedBytes, key: originalKey)
    XCTAssertTrue(original === stale, "Stable asset IDs alone retain pre-edit pixels")

    revisions.didPersist(for: url)
    let edited = await ThumbnailDecoder.image(
      for: editedBytes, key: revisions.decodedKey(for: id, url: url))
    XCTAssertEqual(edited?.width, 16)
    XCTAssertEqual(original?.width, 8)
    XCTAssertFalse(original === edited)
  }

  func testCloudHostsWithTheSameAssetIDKeepTheirOwnBitmap() async throws {
    let revisions = DevelopedImageRevision()
    let id = "fs:/photos/\(UUID().uuidString).dng"
    let firstSource = ThumbnailSource.cloud(absPath: id, host: "server-a:3000")
    let secondSource = ThumbnailSource.cloud(absPath: id, host: "server-b:3000")
    let firstKey = revisions.decodedKey(for: id, source: firstSource)
    let secondKey = revisions.decodedKey(for: id, source: secondSource)
    let firstImage = await ThumbnailDecoder.image(for: try encodedImage(size: 8), key: firstKey)
    let first = try XCTUnwrap(firstImage)
    let secondImage = await ThumbnailDecoder.image(
      for: try encodedImage(size: 8, color: .blue), key: secondKey)
    let second = try XCTUnwrap(secondImage)
    XCTAssertNotEqual(firstKey, secondKey)
    XCTAssertEqual(first.width, 8)
    XCTAssertEqual(second.width, 8)
    XCTAssertNotEqual(first.dataProvider?.data as Data?, second.dataProvider?.data as Data?)
    XCTAssertFalse(first === second)
    XCTAssertTrue(ThumbnailDecoder.cachedImage(forKey: firstKey) === first)
    XCTAssertTrue(ThumbnailDecoder.cachedImage(forKey: secondKey) === second)
  }

  func testCloudAndMergedAndCatalogSeedsShareTheHostNamespace() {
    let revisions = DevelopedImageRevision()
    let id = "fs:/photos/shared.dng"
    let server = URL(string: "http://localhost:3001")!
    let cloud = ThumbnailSource.cloud(absPath: "/photos/shared.dng", host: server.cacheHostKey)
    let merged = ThumbnailSource.merged(
      .cloudOnly(ImageRef(id: id, displayName: "shared.dng")), host: server.cacheHostKey)
    let asset = AssetRef(
      displayName: "shared.dng", hintExtension: "dng", stableID: id,
      thumbnailProvenance: .cloud(server: URL(string: "http://localhost:3002")!),
      catalog: CatalogRef(
        serverID: server, folderID: "photos", absPath: "/photos/shared.dng", address: nil),
      bytesProvider: { throw ImageSourceError.notFound("No bytes needed for identity") })
    let key = revisions.decodedKey(for: id, source: cloud)
    XCTAssertEqual(key, revisions.decodedKey(for: id, source: merged))
    XCTAssertEqual(key, revisions.decodedKey(for: id, source: .local(asset, source: nil)))
    XCTAssertNotEqual(
      key,
      revisions.decodedKey(
        for: id, source: .cloud(absPath: "/photos/shared.dng", host: "localhost:3002")))
    XCTAssertNotEqual(key, revisions.decodedKey(for: id, source: .photoKit(localID: id)))
  }

  func testTimelineProvenanceWithoutCatalogSharesGridKeysAndSeparatesHostBitmaps() async throws {
    let revisions = DevelopedImageRevision()
    let id = "fs:/photos/\(UUID().uuidString).dng"
    let firstServer = URL(string: "http://localhost:3001")!
    let secondServer = URL(string: "http://localhost:3002")!
    let firstBytes = try encodedImage(size: 8)
    let secondBytes = try encodedImage(size: 8, color: .blue)
    // The unified Timeline's cloudAssetRef carries only provenance, not a catalog.
    let firstAsset = AssetRef(
      displayName: "shared.dng", hintExtension: "dng", stableID: id,
      thumbnailProvenance: .cloud(server: firstServer), bytesProvider: { firstBytes })
    let secondAsset = AssetRef(
      displayName: "shared.dng", hintExtension: "dng", stableID: id,
      thumbnailProvenance: .cloud(server: secondServer), bytesProvider: { secondBytes })
    XCTAssertNil(firstAsset.catalog)
    XCTAssertNil(secondAsset.catalog)
    let firstKey = revisions.decodedKey(for: id, source: .local(firstAsset, source: nil))
    let secondKey = revisions.decodedKey(for: id, source: .local(secondAsset, source: nil))
    let gridKey = revisions.decodedKey(
      for: id, source: .cloud(absPath: String(id.dropFirst(3)), host: firstServer.cacheHostKey))
    XCTAssertEqual(firstKey, gridKey)
    XCTAssertNotEqual(firstKey, secondKey)
    let grid = await ThumbnailDecoder.image(for: firstBytes, key: gridKey)
    let firstImage = await ThumbnailDecoder.image(for: firstBytes, key: firstKey)
    let secondImage = await ThumbnailDecoder.image(for: secondBytes, key: secondKey)
    let first = try XCTUnwrap(firstImage)
    let second = try XCTUnwrap(secondImage)
    XCTAssertTrue(grid === first)
    XCTAssertFalse(first === second)
    XCTAssertNotEqual(first.dataProvider?.data as Data?, second.dataProvider?.data as Data?)
  }

  func testSourceAwareKeysRetainLocalRevisionsAndPhotoKitIdentity() {
    let revisions = DevelopedImageRevision()
    let url = URL(fileURLWithPath: "/photos/shared.dng")
    let asset = AssetRef(url: url)
    let source = ThumbnailSource.local(asset, source: nil)
    XCTAssertEqual(revisions.decodedKey(for: "local", source: source), "local")
    revisions.didPersist(for: url)
    XCTAssertEqual(
      revisions.decodedKey(for: "local", source: source),
      revisions.decodedKey(for: "local", url: url))
    let localRef = ImageRef(id: "ph:local", displayName: "local.dng")
    XCTAssertEqual(
      revisions.decodedKey(for: localRef.id, source: .merged(.localOnly(localRef), host: "server")),
      revisions.decodedKey(for: localRef.id, source: .photoKit(localID: localRef.id)))
  }

  func testExternalSidecarRemovalChangesDecodedBitmapIdentity() throws {
    let folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-revision-sidecar-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let asset = folder.appendingPathComponent("photo.jpg")
    let sidecar = SidecarPath.sidecarURL(for: asset)
    try Data([0x01]).write(to: asset)
    try Data("<xmp>crop</xmp>".utf8).write(to: sidecar)

    let revisions = DevelopedImageRevision()
    let withEdit = revisions.decodedKey(for: "photo", url: asset)
    try FileManager.default.removeItem(at: sidecar)
    let withoutEdit = revisions.decodedKey(for: "photo", url: asset)
    XCTAssertNotEqual(withEdit, withoutEdit)

    try Data("<xmp>crop</xmp>".utf8).write(to: sidecar)
    XCTAssertNotEqual(withoutEdit, revisions.decodedKey(for: "photo", url: asset))
  }

  /// #5033: byte-identical copies in two saved folders share a content-derived
  /// id, but each has its own sidecar and thumbnail, so their Timeline tiles
  /// must not share a decoded bitmap.
  func testIdenticalCopiesInTwoSavedFoldersKeepTheirOwnTimelineBitmap() {
    let revisions = DevelopedImageRevision()
    let mapleId = "0123456789abcdef0123456789abcdef"
    let cells = ["/folderA/IMG.dng", "/folderB/IMG.dng"].map {
      MergedTimelineCell.localOnly(
        ImageRef(id: mapleId, displayName: "IMG.dng", url: URL(fileURLWithPath: $0)))
    }
    let items = cells.map {
      PhotoGridItem(merged: $0, host: "", sync: .localOnly, style: .desktop)
    }
    XCTAssertNotEqual(cells[0].id, cells[1].id, "two grid cells must not share one identity")
    XCTAssertEqual(
      cells[0].id, "/folderA/IMG.dng",
      "Preview, the filmstrip and the editor seed look the bitmap up by the file's stableID")
    XCTAssertNotEqual(
      revisions.decodedKey(for: items[0].id, source: items[0].thumbnailSource),
      revisions.decodedKey(for: items[1].id, source: items[1].thumbnailSource))
  }

  func testSaveChangesOnlyTheEditedFilesLoadIdentity() {
    let revisions = DevelopedImageRevision()
    let first = URL(fileURLWithPath: "/first/IMG.dng")
    let second = URL(fileURLWithPath: "/second/IMG.dng")
    let changed = expectation(description: "Retained SwiftUI image observes save")
    withObservationTracking {
      _ = revisions.revision(for: first)
    } onChange: {
      changed.fulfill()
    }
    revisions.didPersist(for: first)
    XCTAssertEqual(revisions.revision(for: first), 1)
    XCTAssertEqual(revisions.revision(for: second), 0)
    XCTAssertEqual(revisions.decodedKey(for: "cloud", url: nil), "cloud")
    wait(for: [changed], timeout: 1)
  }

  private func encodedImage(size: Int, color: CIColor = .red) throws -> Data {
    let image = CIImage(color: color).cropped(
      to: CGRect(x: 0, y: 0, width: size, height: size))
    return try XCTUnwrap(ThumbnailEncoder.encode(image, ctx: CIContext()))
  }
}
