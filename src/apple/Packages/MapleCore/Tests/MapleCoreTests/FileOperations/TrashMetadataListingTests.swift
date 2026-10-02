import XCTest

@testable import MapleCore

/// #4009: Windows original-path metadata must not become restorable photos.
final class TrashMetadataListingTests: XCTestCase {
  private let files = [
    "photo.dng": "original pixels",
    "photo.xmp": "<x:xmpmeta>authored sidecar</x:xmpmeta>",
    "photo.dng.origpath": "Album/photo.dng",
    "orphan.origpath": "../private/photo.dng",
    "nested/photo2.dng": "nested original pixels",
    "nested/photo2.dng.ORIGPATH": "Album/photo2.dng",
    "photo.origpath.jpg": "a real photo, not metadata",
  ]

  func testLocalListingExcludesWindowsMetadataAndPreservesRealFiles() throws {
    let root = FileOperationsTestSupport.makeTempDir().resolvingSymlinksInPath()
    defer { FileOperationsTestSupport.cleanup(root) }
    let trash = root.appendingPathComponent(".maple/trash")
    for (name, bytes) in files {
      FileOperationsTestSupport.write(bytes, to: trash.appendingPathComponent(name))
    }
    let listed = LocalFileOperations.listMapleTrash(libraryRoot: root)
    XCTAssertEqual(
      listed.map(\.originalRelativePath).sorted(),
      [
        "nested/photo2.dng", "photo.dng", "photo.origpath.jpg",
      ])
    let photo = try XCTUnwrap(listed.first { $0.displayName == "photo.dng" })
    let sidecar = try XCTUnwrap(photo.sidecarPath)
    XCTAssertEqual((sidecar as NSString).lastPathComponent, "photo.xmp")
    XCTAssertEqual(try String(contentsOfFile: sidecar, encoding: .utf8), files["photo.xmp"])
    XCTAssertNil(photo.trashedDate, "a Windows path marker carries no known retention date")
    for (name, bytes) in files {
      XCTAssertEqual(
        try String(contentsOf: trash.appendingPathComponent(name), encoding: .utf8), bytes)
    }
  }

  func testSMBListingExcludesWindowsMetadataUnderNestedShareRoot() async throws {
    let transport = FakeSMBTransport()
    for (name, bytes) in files {
      await transport.seed(bytes, at: "/Photos/.maple/trash/\(name)")
    }
    let listed = await SMBFileOperations.listMapleTrash(shareRoot: "/Photos", transport: transport)
    XCTAssertEqual(
      listed.map(\.originalRelativePath).sorted(),
      [
        "nested/photo2.dng", "photo.dng", "photo.origpath.jpg",
      ])
    let photo = try XCTUnwrap(listed.first { $0.displayName == "photo.dng" })
    XCTAssertEqual(photo.sidecarPath, "/Photos/.maple/trash/photo.xmp")
    XCTAssertNil(photo.trashedDate)
    for (name, bytes) in files {
      let remaining = await transport.fileContents(at: "/Photos/.maple/trash/\(name)")
      XCTAssertEqual(remaining, bytes)
    }
  }
}
