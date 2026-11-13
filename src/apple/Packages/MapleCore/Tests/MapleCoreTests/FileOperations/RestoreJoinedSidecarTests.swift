import Foundation
import XCTest

@testable import MapleCore

final class RestoreJoinedSidecarTests: XCTestCase {
  func testLocalJoinedSidecarChangeRetainsTrashAndWithdrawsPrimary() throws {
    let root = FileOperationsTestSupport.makeTempDir()
    defer { FileOperationsTestSupport.cleanup(root) }
    let source = root.appendingPathComponent(".maple/trash/photo.dng")
    let incoming = source.deletingPathExtension().appendingPathExtension("xmp")
    let destination = root.appendingPathComponent("photo.xmp")
    FileOperationsTestSupport.write("raw", to: source)
    FileOperationsTestSupport.write("<original/>", to: incoming)
    FileOperationsTestSupport.write("<original/>", to: destination)
    XCTAssertThrowsError(
      try LocalFileOperations.restoreFilePair(
        source, to: root, confinedTo: root,
        beforeClaim: { _, _ in try Data("<new edit/>".utf8).write(to: destination) }))
    XCTAssertEqual(FileOperationsTestSupport.contents(incoming), "<original/>")
    XCTAssertEqual(FileOperationsTestSupport.contents(destination), "<new edit/>")
    XCTAssertTrue(FileOperationsTestSupport.exists(source))
    XCTAssertFalse(FileOperationsTestSupport.exists(root.appendingPathComponent("photo.dng")))
  }

  func testSMBJoinedSidecarChangeRetainsTrashAndWithdrawsPrimary() async throws {
    let transport = FakeSMBTransport()
    await transport.seed("raw", at: "/trash/photo.dng")
    await transport.seed("<original/>", at: "/trash/photo.xmp")
    await transport.seed("<original/>", at: "/live/photo.xmp")
    await transport.setReplacementAtPublish(
      "/live/photo.dng", item: "/live/photo.xmp", contents: "<new edit/>")
    do {
      _ = try await SMBFileOperations.restoreFilePair(
        "/trash/photo.dng", to: "/live", staging: "/stage", transport: transport)
      XCTFail("Changed joined sidecar was accepted")
    } catch {}
    let source = await transport.fileContents(at: "/trash/photo.xmp")
    let destination = await transport.fileContents(at: "/live/photo.xmp")
    let primary = await transport.fileExists(at: "/live/photo.dng")
    XCTAssertEqual(source, "<original/>")
    XCTAssertEqual(destination, "<new edit/>")
    XCTAssertFalse(primary)
  }

  func testSMBJoinsCaseVariantOnlyWithPositiveMatchingIdentity() async throws {
    let transport = FakeSMBTransport()
    await transport.setFoldsCase(true)
    await transport.seed("raw", at: "/trash/photo.dng")
    await transport.seed("<original/>", at: "/trash/photo.xmp")
    await transport.seed("<original/>", at: "/live/photo.XMP")
    let outcome = try await SMBFileOperations.restoreFilePair(
      "/trash/photo.dng", to: "/live", staging: "/stage", transport: transport)
    XCTAssertFalse(outcome.renamedDueToCollision)
    XCTAssertEqual(outcome.sidecarPath, "/live/photo.XMP")
    let contents = await transport.fileContents(at: "/live/photo.XMP")
    XCTAssertEqual(contents, "<original/>")
  }
}
