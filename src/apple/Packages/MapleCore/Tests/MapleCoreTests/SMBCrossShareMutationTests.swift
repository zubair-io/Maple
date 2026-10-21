import Foundation
import XCTest

@testable import MapleCore

/// #4987: two shares can hold a file at the same path. A reference listed on
/// one share must never rename, move, trash or write sidecars on the other,
/// even when a caller hands it to the wrong connection.
@MainActor
final class SMBCrossShareMutationTests: EditorTestCase {
  func testReferenceListedOnOneShareCannotMutateTheSamePathOnAnother() async throws {
    let listing = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let other = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let browse = BrowseViewModel()
    await browse.loadSource(listing.source)
    let asset = try XCTUnwrap(browse.assets.first { $0.displayName == "photo.dng" })
    let ref = try XCTUnwrap(asset.smbMutationRef)
    XCTAssertEqual(ref.smbPath, "/photo.dng")
    let untouched = try snapshot(other.share)
    var model = AdjustmentModel.default
    model.exposure = 2

    try await assertRefused("writeXMP") {
      try await other.source.writeXMP(Sidecar(model: model, culling: CullingState()), for: ref)
    }
    try await assertRefused("sidecar store") {
      try await SMBSidecarStore(source: other.source, ref: ref)
        .writeConfirmed(model: model, culling: CullingState())
    }
    try await assertRefused("rename") {
      _ = try await other.source.renameAsset(ref, to: "renamed.dng")
    }
    try await assertRefused("move") {
      _ = try await other.source.relocateAsset(
        ref, to: "/Moved", mode: .move, collision: .autoSuffix)
    }
    try await assertRefused("trash") { _ = try await other.source.trashAsset(ref) }
    XCTAssertEqual(try snapshot(other.share), untouched)

    _ = try await listing.source.trashAsset(ref)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: listing.raw.path),
      "the share that listed the photo still accepts its own reference")
  }

  /// The same connection object reopened on another share must retire its
  /// earlier refs; reopening the same share at another address must not.
  func testReconnectingToAnotherShareRetiresEarlierReferences() async throws {
    let listing = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let other = try await OwnedSMBWorkflowFixture.open(testCase: self, shareName: "ARCHIVE")
    let ref = try await listing.image()
    await listing.source.disconnect()
    try await listing.source.connect(credentials: other.credentials)
    _ = try await listing.source.images()

    try await assertRefused("trash after switching shares") {
      _ = try await listing.source.trashAsset(ref)
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: other.raw.path))
  }

  /// #5051: a thumbnail write-back or a read through a ref listed on another
  /// share never lands on, or reads, the same path here.
  func testThumbnailsAndReadsStayOnTheShareThatListedTheReference() async throws {
    let listing = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let other = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let ref = try await listing.image()

    await other.source.writeThumb(Data("share A's picture".utf8), for: ref)

    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: other.share.appendingPathComponent(".maple/thumbs").path),
      "a thumbnail for share A's photo was cached on share B")
    let thumb = try await other.source.thumb(for: ref)
    XCTAssertNil(thumb)
    try await assertRefused("rawBytes") { _ = try await other.source.rawBytes(for: ref) }
    try await assertRefused("sidecar read") { _ = try await other.source.readSidecarData(for: ref) }
  }

  /// #5051: reconnecting the same share through another address keeps a
  /// rename's relocation, so a later sidecar write follows the renamed file.
  func testReconnectingAtAnotherAddressKeepsRelocations() async throws {
    let listing = try await OwnedSMBWorkflowFixture.open(testCase: self, initialXML: nil)
    let ref = try await listing.image()
    _ = try await listing.source.renameAsset(ref, to: "renamed.dng")
    let port = try XCTUnwrap(listing.credentials.host.split(separator: ":").last)
    await listing.source.disconnect()
    try await listing.source.connect(
      credentials: .init(
        host: "127.1:\(port)", share: listing.credentials.share,
        username: listing.credentials.username, password: listing.credentials.password))

    try await listing.source.writeXMP(
      Sidecar(model: .default, culling: CullingState()), for: ref)

    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: listing.share.appendingPathComponent("renamed.xmp").path))
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: listing.share.appendingPathComponent("photo.xmp").path))
  }

  private func assertRefused(_ label: String, _ mutation: () async throws -> Void) async throws {
    do {
      try await mutation()
      XCTFail("\(label) mutated the same path on a share that never listed it")
    } catch SMBError.foreignShare(let name) {
      XCTAssertEqual(name, "photo.dng", label)
    }
  }

  /// Share-relative path -> bytes, excluding Maple's own `.maple` caches.
  private func snapshot(_ share: URL) throws -> [String: Data] {
    try FileManager.default.subpathsOfDirectory(atPath: share.path)
      .filter { !$0.hasPrefix(".maple") }
      .reduce(into: [:]) { result, relative in
        let url = share.appendingPathComponent(relative)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
          !isDirectory.boolValue
        else { return }
        result[relative] = try Data(contentsOf: url)
      }
  }
}
