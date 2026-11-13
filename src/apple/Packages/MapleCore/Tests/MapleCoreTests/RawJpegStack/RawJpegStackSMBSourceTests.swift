import XCTest

@testable import MapleCore

/// #5050 review: `SMBSource` carries a stacked JPEG over a real, owned Samba share. Both names are
/// decided before either file moves, Keep Both keeps the pair under one stem, and the RAW's Replace
/// never reaches an unrelated JPEG.
@MainActor
final class RawJpegStackSMBSourceTests: XCTestCase {
  private struct Pair {
    let fixture: OwnedSMBWorkflowFixture
    let raw: ImageRef
    let jpeg: ImageRef
    let album: URL
  }

  /// `photo.dng` + `photo.jpg` + `photo.xmp` at the share root, and an `Album` folder holding
  /// `occupants`.
  private func openPair(albumHolding occupants: [String: String]) async throws -> Pair {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    try Data("jpeg-bytes".utf8).write(to: fixture.share.appendingPathComponent("photo.jpg"))
    let album = fixture.share.appendingPathComponent("Album", isDirectory: true)
    try FileManager.default.createDirectory(at: album, withIntermediateDirectories: true)
    for (name, contents) in occupants {
      try Data(contents.utf8).write(to: album.appendingPathComponent(name))
    }
    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: fixture.credentials)
    let images = try await fixture.source.images()
    let raw = try XCTUnwrap(images.first { $0.smbPath == "/photo.dng" })
    let jpeg = try XCTUnwrap(images.first { $0.smbPath == "/photo.jpg" })
    return Pair(fixture: fixture, raw: raw, jpeg: jpeg, album: album)
  }

  private func names(_ directory: URL) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])
      .filter { !$0.hasPrefix(".") }.sorted()
  }

  private func text(_ directory: URL, _ name: String) -> String? {
    (try? Data(contentsOf: directory.appendingPathComponent(name))).flatMap {
      String(data: $0, encoding: .utf8)
    }
  }

  /// Keep Both used to move the RAW as `photo.1.dng`, fail the JPEG under its own name, and put the
  /// RAW back at the root still called `photo.1.dng`.
  func testKeepBothMovesThePairToOneFreeStem() async throws {
    let pair = try await openPair(albumHolding: ["photo.dng": "old-raw", "photo.jpg": "old-jpeg"])

    let outcome = try await pair.fixture.source.relocateAsset(
      pair.raw, companion: pair.jpeg, to: "/Album", mode: .move, collision: .autoSuffix)

    XCTAssertEqual(
      names(pair.album), ["photo.1.dng", "photo.1.jpg", "photo.1.xmp", "photo.dng", "photo.jpg"])
    XCTAssertEqual(text(pair.album, "photo.dng"), "old-raw")
    XCTAssertEqual(text(pair.album, "photo.jpg"), "old-jpeg")
    XCTAssertEqual(text(pair.album, "photo.1.jpg"), "jpeg-bytes")
    XCTAssertEqual(outcome.primary.primaryPath, "/Album/photo.1.dng")
    XCTAssertEqual(outcome.companion.primaryPath, "/Album/photo.1.jpg")
    XCTAssertEqual(names(pair.fixture.share), ["Album"])
  }

  func testKeepBothWithOnlyTheJpegNameTakenStillKeepsOneStem() async throws {
    let pair = try await openPair(albumHolding: ["photo.jpg": "old-jpeg"])

    _ = try await pair.fixture.source.relocateAsset(
      pair.raw, companion: pair.jpeg, to: "/Album", mode: .move, collision: .autoSuffix)

    XCTAssertEqual(names(pair.album), ["photo.1.dng", "photo.1.jpg", "photo.1.xmp", "photo.jpg"])
    XCTAssertEqual(text(pair.album, "photo.jpg"), "old-jpeg")
  }

  func testReplaceOnTheRawNeverReplacesAnUnrelatedJpeg() async throws {
    let pair = try await openPair(albumHolding: ["photo.dng": "old-raw", "photo.jpg": "old-jpeg"])

    do {
      _ = try await pair.fixture.source.relocateAsset(
        pair.raw, companion: pair.jpeg, to: "/Album", mode: .move, collision: .replace)
      XCTFail("the JPEG was never asked about")
    } catch FileOperationError.destinationExists(let path) {
      XCTAssertEqual(path, "/Album/photo.jpg")
    }

    XCTAssertEqual(names(pair.album), ["photo.dng", "photo.jpg"])
    XCTAssertEqual(text(pair.album, "photo.dng"), "old-raw")
    XCTAssertEqual(text(pair.album, "photo.jpg"), "old-jpeg")
    XCTAssertEqual(names(pair.fixture.share), ["Album", "photo.dng", "photo.jpg", "photo.xmp"])
  }

  func testReplacingBothAfterTheJpegsOwnPromptMovesThePair() async throws {
    let pair = try await openPair(albumHolding: ["photo.dng": "old-raw", "photo.jpg": "old-jpeg"])

    _ = try await pair.fixture.source.relocateAsset(
      pair.raw, companion: pair.jpeg, to: "/Album", mode: .move, collision: .replace,
      companionCollision: .replace)

    XCTAssertEqual(names(pair.album), ["photo.dng", "photo.jpg", "photo.xmp"])
    XCTAssertEqual(text(pair.album, "photo.jpg"), "jpeg-bytes")
    XCTAssertEqual(names(pair.fixture.share), ["Album"])
  }

  /// Replacing an edited destination pair used to fail: the destination JPEG still claimed the
  /// destination sidecar while the RAW was placed, so its replacement was refused even though the
  /// user had chosen to replace that JPEG too.
  func testReplacingAnEditedDestinationPairReplacesItsSidecar() async throws {
    let pair = try await openPair(
      albumHolding: ["photo.dng": "old-raw", "photo.jpg": "old-jpeg", "photo.xmp": "<old/>"])
    let sourceSidecar = try XCTUnwrap(text(pair.fixture.share, "photo.xmp"))

    _ = try await pair.fixture.source.relocateAsset(
      pair.raw, companion: pair.jpeg, to: "/Album", mode: .move, collision: .replace,
      companionCollision: .replace)

    XCTAssertEqual(names(pair.album), ["photo.dng", "photo.jpg", "photo.xmp"])
    XCTAssertEqual(text(pair.album, "photo.jpg"), "jpeg-bytes")
    XCTAssertEqual(text(pair.album, "photo.xmp"), sourceSidecar)
    XCTAssertEqual(names(pair.fixture.share), ["Album"])
  }

  /// Replace on both used to lose the destination's RAW and sidecar when the JPEG could not land
  /// (a folder holds its name): the RAW's relocation deleted the files it displaced as soon as the
  /// RAW was in place, so moving the RAW back could not bring them back.
  func testAJpegThatCannotLandPutsBackTheFilesTheRawDisplaced() async throws {
    let pair = try await openPair(albumHolding: ["photo.dng": "old-raw", "photo.xmp": "<old/>"])
    try FileManager.default.createDirectory(
      at: pair.album.appendingPathComponent("photo.jpg"), withIntermediateDirectories: true)
    let sourceRaw = try Data(contentsOf: pair.fixture.raw)
    let sourceSidecar = try XCTUnwrap(text(pair.fixture.share, "photo.xmp"))

    do {
      _ = try await pair.fixture.source.relocateAsset(
        pair.raw, companion: pair.jpeg, to: "/Album", mode: .move, collision: .replace,
        companionCollision: .replace)
      XCTFail("a folder holds the JPEG's name")
    } catch FileOperationError.invalidDestination {}

    let everything = try FileManager.default.contentsOfDirectory(atPath: pair.album.path).sorted()
    XCTAssertEqual(everything, ["photo.dng", "photo.jpg", "photo.xmp"])
    XCTAssertEqual(text(pair.album, "photo.dng"), "old-raw")
    XCTAssertEqual(text(pair.album, "photo.xmp"), "<old/>")
    XCTAssertEqual(names(pair.fixture.share), ["Album", "photo.dng", "photo.jpg", "photo.xmp"])
    XCTAssertEqual(try Data(contentsOf: pair.fixture.raw), sourceRaw)
    XCTAssertEqual(text(pair.fixture.share, "photo.jpg"), "jpeg-bytes")
    XCTAssertEqual(text(pair.fixture.share, "photo.xmp"), sourceSidecar)
  }

  /// A Keep Both copy used to copy the JPEG under its own name beside a suffixed RAW: only a move
  /// re-aligned the stems.
  func testKeepBothCopyGivesTheJpegTheRawsSuffixedStem() async throws {
    let pair = try await openPair(albumHolding: ["photo.dng": "old-raw"])

    let outcome = try await pair.fixture.source.relocateAsset(
      pair.raw, companion: pair.jpeg, to: "/Album", mode: .copy, collision: .autoSuffix)

    XCTAssertEqual(names(pair.album), ["photo.1.dng", "photo.1.jpg", "photo.1.xmp", "photo.dng"])
    XCTAssertEqual(outcome.companion.primaryPath, "/Album/photo.1.jpg")
    XCTAssertEqual(names(pair.fixture.share), ["Album", "photo.dng", "photo.jpg", "photo.xmp"])
  }

  func testRenameGivesBothFilesTheNewStemAndRefusesATakenJpegName() async throws {
    let pair = try await openPair(albumHolding: [:])
    try Data("other".utf8).write(to: pair.fixture.share.appendingPathComponent("taken.jpg"))

    do {
      _ = try await pair.fixture.source.renameAsset(pair.raw, companion: pair.jpeg, to: "taken.dng")
      XCTFail("taken.jpg exists")
    } catch FileOperationError.destinationExists(let path) {
      XCTAssertEqual(path, "/taken.jpg")
    }
    XCTAssertEqual(
      names(pair.fixture.share), ["Album", "photo.dng", "photo.jpg", "photo.xmp", "taken.jpg"])

    let paths = try await pair.fixture.source.renameAsset(
      pair.raw, companion: pair.jpeg, to: "Trip.dng")

    XCTAssertEqual(paths.primary, "/Trip.dng")
    XCTAssertEqual(paths.companion, "/Trip.jpg")
    XCTAssertEqual(
      names(pair.fixture.share), ["Album", "Trip.dng", "Trip.jpg", "Trip.xmp", "taken.jpg"])
  }

  /// The RAW and the JPEG were trashed one call each, each suffixing on its own: with an older
  /// `photo.dng` in the trash, the JPEG and the sidecar landed as `photo.jpg` and `photo.xmp`
  /// beside that RAW while this RAW became `photo.1.dng`.
  func testTrashKeepsThePairUnderOneStemBesideAnOlderTrashedRaw() async throws {
    let pair = try await openPair(albumHolding: [:])
    let sidecar = try XCTUnwrap(text(pair.fixture.share, "photo.xmp"))
    let trash = pair.fixture.share.appendingPathComponent(".maple/trash", isDirectory: true)
    try FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
    try Data("old-raw".utf8).write(to: trash.appendingPathComponent("photo.dng"))

    let outcome = try await pair.fixture.source.trashAsset(pair.raw, companion: pair.jpeg)

    XCTAssertEqual(outcome.primaryPath, "/.maple/trash/photo.1.dng")
    XCTAssertEqual(outcome.companionPath, "/.maple/trash/photo.1.jpg")
    XCTAssertEqual(
      names(trash).filter { !$0.contains(".trashed-") },
      ["photo.1.dng", "photo.1.jpg", "photo.1.xmp", "photo.dng"])
    XCTAssertEqual(text(trash, "photo.dng"), "old-raw")
    XCTAssertEqual(text(trash, "photo.1.jpg"), "jpeg-bytes")
    XCTAssertEqual(text(trash, "photo.1.xmp"), sidecar)
    XCTAssertEqual(names(pair.fixture.share), ["Album"])
    let trashed = try await pair.fixture.source.listTrash().filter { $0.trashedDate != nil }
    XCTAssertEqual(
      Set(trashed.map(\.primaryPath)), ["/.maple/trash/photo.1.dng", "/.maple/trash/photo.1.jpg"])
    let listed = try await pair.fixture.source.images().compactMap(\.smbPath)
    XCTAssertTrue(listed.allSatisfy { !$0.hasPrefix("/.maple/") }, "\(listed)")
  }
}
