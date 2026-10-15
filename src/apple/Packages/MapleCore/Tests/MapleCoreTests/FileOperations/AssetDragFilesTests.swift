import XCTest

@testable import MapleCore

final class AssetDragFilesTests: XCTestCase {
  private var root: URL!

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

  func testLocalDragCopiesOriginalBytesAndLeavesOriginalAndSidecarUntouched() async throws {
    let source = root.appendingPathComponent("Original photo.dng")
    let sidecar = root.appendingPathComponent("Original photo.xmp")
    let originalBytes = Data([0x49, 0x49, 0x2A, 0, 0, 0xFF])
    let sidecarBytes = Data("<x:xmpmeta>original edits</x:xmpmeta>".utf8)
    try originalBytes.write(to: source)
    try sidecarBytes.write(to: sidecar)
    let destination = root.appendingPathComponent("copied.dng")

    try await AssetDragFiles.shared.writeOriginal(AssetRef(url: source), to: destination)

    XCTAssertEqual(try Data(contentsOf: destination), originalBytes)
    XCTAssertEqual(try Data(contentsOf: source), originalBytes)
    XCTAssertEqual(try Data(contentsOf: sidecar), sidecarBytes)
  }

  func testRemoteDragWritesFullOriginalWithItsFilename() async throws {
    let bytes = Data([0xFF, 0xD8, 0, 0xFF, 0xD9])
    let asset = AssetRef(displayName: "Remote photo.jpg", hintExtension: "jpg") { bytes }
    let destination = root.appendingPathComponent(AssetDragFiles.fileName(for: asset))

    try await AssetDragFiles.shared.writeOriginal(asset, to: destination)

    XCTAssertEqual(destination.lastPathComponent, "Remote photo.jpg")
    XCTAssertEqual(try Data(contentsOf: destination), bytes)
  }

  func testExistingDestinationAndOriginalCannotBeOverwritten() async throws {
    let source = root.appendingPathComponent("original.dng")
    let destination = root.appendingPathComponent("existing.dng")
    let bytes = Data([1, 2, 3])
    let existing = Data([4, 5, 6])
    try bytes.write(to: source)
    try existing.write(to: destination)
    let remote = AssetRef(displayName: "remote.dng", hintExtension: "dng") { bytes }

    for (asset, target) in [
      (AssetRef(url: source), destination), (remote, destination),
      (AssetRef(url: source), source),
    ] {
      do {
        try await AssetDragFiles.shared.writeOriginal(asset, to: target)
        XCTFail("Drag must refuse an occupied destination")
      } catch {}
    }
    XCTAssertEqual(try Data(contentsOf: source), bytes)
    XCTAssertEqual(try Data(contentsOf: destination), existing)
  }

  func testRemoteFailureIsReportedWithoutCreatingAFile() async throws {
    let asset = AssetRef(displayName: "offline.dng", hintExtension: "dng") {
      throw ImageSourceError.notFound("offline")
    }
    let destination = root.appendingPathComponent("offline.dng")
    do {
      try await AssetDragFiles.shared.writeOriginal(asset, to: destination)
      XCTFail("A failed fetch must fail the file promise")
    } catch {
      XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    }
  }

  func testRemoteFilenameStaysInsideDropDestination() {
    let asset = AssetRef(displayName: "../../photo", hintExtension: "dng") { Data() }
    XCTAssertEqual(AssetDragFiles.fileName(for: asset), "photo.dng")
  }
}
