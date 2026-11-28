import XCTest

@testable import MapleCore

/// #6134 review: the share round trips a move costs, canonically equivalent names, an unlistable
/// folder, and the rollback and collision paths around conflict copies.
final class SMBConflictCopySafetyTests: XCTestCase {
  private let mac = "photo (conflict from Mac).xmp"
  private let listingsBeforeConflictCopies = 2

  private func shelf(_ extra: [String: String] = [:]) async -> FakeSMBTransport {
    let transport = FakeSMBTransport()
    await transport.seed("pixels", at: "/src/photo.CR3")
    await transport.seed("<canonical/>", at: "/src/photo.xmp")
    await transport.seed("<mac/>", at: "/src/\(mac)")
    for (path, contents) in extra { await transport.seed(contents, at: path) }
    return transport
  }

  private func normalized(_ files: [String: String]) -> [String: String] {
    Dictionary(
      uniqueKeysWithValues: files.map { ($0.key.precomposedStringWithCanonicalMapping, $0.value) })
  }

  // MARK: - Round trips

  func testAMoveCostsTheSameListingsAsBeforeConflictCopies() async throws {
    let transport = await shelf()

    _ = try await SMBFileOperations.relocate(
      "/src/photo.CR3", to: "/dest", mode: .move, collision: .fail, transport: transport)

    let listings = await transport.listingCount
    XCTAssertEqual(listings, listingsBeforeConflictCopies)
  }

  func testAutoSuffixProbesDoNotListAgain() async throws {
    let taken = Dictionary(
      uniqueKeysWithValues: (0...6).map { n in
        (n == 0 ? "/dest/photo.CR3" : "/dest/photo.\(n).CR3", "occupant \(n)")
      })
    let transport = await shelf(taken)

    let outcome = try await SMBFileOperations.relocate(
      "/src/photo.CR3", to: "/dest", mode: .move, collision: .autoSuffix, transport: transport)

    XCTAssertEqual((outcome.primaryPath as NSString).lastPathComponent, "photo.7.CR3")
    let listings = await transport.listingCount
    XCTAssertEqual(listings, listingsBeforeConflictCopies)
  }

  // MARK: - Fail closed

  func testAnUnlistableDestinationStopsTheMoveWithNothingChanged() async throws {
    let transport = await shelf(["/dest/other.CR3": "other"])
    await transport.setFailListing(of: "/dest")

    do {
      _ = try await SMBFileOperations.relocate(
        "/src/photo.CR3", to: "/dest", mode: .move, transport: transport)
      XCTFail("a destination that cannot be listed must stop the move")
    } catch FileOperationError.underlying(let message) {
      XCTAssertTrue(message.contains("/dest"))
    }

    let files = await transport.allFiles()
    XCTAssertEqual(
      files,
      [
        "/src/photo.CR3": "pixels", "/src/photo.xmp": "<canonical/>", "/src/\(mac)": "<mac/>",
        "/dest/other.CR3": "other",
      ])
  }

  func testAShareThatDropsBothTheListingAndTheAttributeReadOfTheSourceFolderStopsTheMove()
    async throws
  {
    let transport = await shelf(["/src/photo.JPG": "jpeg"])
    await transport.setFailListing(of: "/src")
    await transport.setFailAttributes(of: "/src")

    do {
      _ = try await SMBFileOperations.relocate(
        "/src/photo.CR3", to: "/dest", mode: .move, transport: transport)
      XCTFail("a source folder that cannot be read must not read as empty")
    } catch FileOperationError.underlying {
    }

    let files = await transport.allFiles()
    XCTAssertEqual(
      files,
      [
        "/src/photo.CR3": "pixels", "/src/photo.JPG": "jpeg", "/src/photo.xmp": "<canonical/>",
        "/src/\(mac)": "<mac/>",
      ])
  }

  func testAShareThatDropsBothTheListingAndTheAttributeReadOfTheDestinationStopsTheMove()
    async throws
  {
    let transport = await shelf(["/dest/other.CR3": "other", "/dest/other.xmp": "<other/>"])
    await transport.setFailListing(of: "/dest")
    await transport.setFailAttributes(of: "/dest")

    do {
      _ = try await SMBFileOperations.relocate(
        "/src/photo.CR3", to: "/dest", mode: .move, collision: .replace, transport: transport)
      XCTFail("a destination folder that cannot be read must not read as empty")
    } catch FileOperationError.underlying {
    }

    let files = await transport.allFiles()
    XCTAssertEqual(files["/src/photo.CR3"], "pixels")
    XCTAssertEqual(files["/src/photo.xmp"], "<canonical/>")
    XCTAssertEqual(files["/dest/other.xmp"], "<other/>")
    XCTAssertNil(files["/dest/photo.CR3"])
  }

  func testAFirstTrashIntoAFolderThatDoesNotExistYetStillWorks() async throws {
    let transport = await shelf()

    _ = try await SMBFileOperations.trash("/src/photo.CR3", transport: transport)

    let trashed = await transport.fileContents(at: "/.maple/trash/src/\(mac)")
    XCTAssertEqual(trashed, "<mac/>")
  }

  // MARK: - Rollback and collisions

  func testAFailedPrimaryPublishWithdrawsTheConflictCopiesAlreadyPublished() async throws {
    let transport = await shelf()
    await transport.setReplacementAtCopy(
      "/src/photo.CR3", item: "/dest/photo.CR3", contents: "raced")

    do {
      _ = try await SMBFileOperations.relocate(
        "/src/photo.CR3", to: "/dest", mode: .move, collision: .fail, transport: transport)
      XCTFail("a name taken while the copy was staged is a collision")
    } catch FileOperationError.destinationExists {
    }

    let files = await transport.allFiles()
    XCTAssertEqual(
      files,
      [
        "/src/photo.CR3": "pixels", "/src/photo.xmp": "<canonical/>", "/src/\(mac)": "<mac/>",
        "/dest/photo.CR3": "raced",
      ])
  }

  func testReplaceRefusesADestinationThatHoldsAnotherPhotosConflictCopy() async throws {
    let transport = await shelf(["/dest/photo.CR3": "old", "/dest/\(mac)": "<theirs/>"])

    do {
      _ = try await SMBFileOperations.relocate(
        "/src/photo.CR3", to: "/dest", mode: .move, collision: .replace, transport: transport)
      XCTFail("Replace must not attach the old photo's conflict copy to this photo")
    } catch FileOperationError.destinationExists {
    }

    let files = await transport.allFiles()
    XCTAssertEqual(files["/dest/photo.CR3"], "old")
    XCTAssertEqual(files["/dest/\(mac)"], "<theirs/>")
    XCTAssertEqual(files["/src/photo.CR3"], "pixels")
    XCTAssertEqual(files["/src/\(mac)"], "<mac/>")
  }

  func testTrashingBothHalvesOfAPairKeepsOneConflictCopyUnderTheTrashedStem() async throws {
    let transport = await shelf(["/src/photo.JPG": "jpeg"])
    let trashDirectory = try SMBFileOperations.trashDestinationDir(
      for: "/src/photo.CR3", shareRoot: "/")

    _ = try await SMBFileOperations.relocate(
      "/src/photo.CR3", to: trashDirectory, mode: .move, collision: .fail, transport: transport)
    let keptForTheJpeg = await transport.fileContents(at: "/src/\(mac)")
    _ = try await SMBFileOperations.relocate(
      "/src/photo.JPG", to: trashDirectory, mode: .move, collision: .fail, transport: transport)

    let trashed = await transport.fileContents(at: "\(trashDirectory)/\(mac)")
    let leftBehind = await transport.fileExists(at: "/src/\(mac)")
    let suffixed = await transport.fileExists(
      at: "\(trashDirectory)/photo.1 (conflict from Mac).xmp")
    XCTAssertEqual(keptForTheJpeg, "<mac/>")
    XCTAssertEqual(trashed, "<mac/>")
    XCTAssertFalse(leftBehind)
    XCTAssertFalse(suffixed)
  }

  func testAPhotoNamedLikeAConflictCopyKeepsItsOwnSidecarAndCarriesItsRealCopy() async throws {
    let transport = FakeSMBTransport()
    await transport.seed("pixels", at: "/src/A (conflict from B).dng")
    await transport.seed("<own/>", at: "/src/A (conflict from B).xmp")
    await transport.seed("<copy/>", at: "/src/A (conflict from B) (conflict from Mac).xmp")
    await transport.seed("other", at: "/src/A.dng")
    await transport.seed("<a/>", at: "/src/A.xmp")

    _ = try await SMBFileOperations.relocate(
      "/src/A (conflict from B).dng", to: "/dest", mode: .move, transport: transport)

    let files = await transport.allFiles()
    XCTAssertEqual(files["/dest/A (conflict from B).xmp"], "<own/>")
    XCTAssertEqual(files["/dest/A (conflict from B) (conflict from Mac).xmp"], "<copy/>")
    XCTAssertEqual(files["/src/A.xmp"], "<a/>")
    XCTAssertNil(files["/dest/A.xmp"])
  }

  // MARK: - Canonically equivalent names

  func testADecomposedCopyFollowsAComposedPhoto() async throws {
    let transport = FakeSMBTransport()
    await transport.seed("pixels", at: "/src/caf\u{e9}.CR3")
    await transport.seed("<copy/>", at: "/src/cafe\u{301} (conflict from Mac).xmp")

    _ = try await SMBFileOperations.relocate(
      "/src/caf\u{e9}.CR3", to: "/dest", mode: .move, transport: transport)

    let files = normalized(await transport.allFiles())
    XCTAssertEqual(files["/dest/caf\u{e9} (conflict from Mac).xmp"], "<copy/>")
    XCTAssertNil(files["/src/caf\u{e9} (conflict from Mac).xmp"])
  }

  func testAComposedCopyFollowsADecomposedPhoto() async throws {
    let transport = FakeSMBTransport()
    await transport.seed("pixels", at: "/src/cafe\u{301}.CR3")
    await transport.seed("<copy/>", at: "/src/caf\u{e9} (conflict from Mac).xmp")

    _ = try await SMBFileOperations.relocate(
      "/src/cafe\u{301}.CR3", to: "/dest", mode: .move, transport: transport)

    let files = normalized(await transport.allFiles())
    XCTAssertEqual(files["/dest/caf\u{e9} (conflict from Mac).xmp"], "<copy/>")
    XCTAssertNil(files["/src/caf\u{e9} (conflict from Mac).xmp"])
  }

  func testADecomposedCopyBesideItsPhotoInTrashIsNotAnOrphan() {
    XCTAssertFalse(
      SidecarOwnership.isOrphanedSidecar(
        "cafe\u{301} (conflict from Mac).xmp", siblingNames: ["caf\u{e9}.CR3"]))
  }
}
