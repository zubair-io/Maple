import XCTest

@testable import MapleCore

/// #6134: a photo's conflict copies (`<stem> (conflict from <device>).xmp`) travel with it on move,
/// rename and trash, under the same rules as its canonical sidecar. Real files in a temp dir.
final class LocalConflictCopyTests: XCTestCase {
  private var root: URL!
  private let mac = "photo (conflict from Mac).xmp"
  private let numbered = "photo (conflict from iPad) (2).xmp"

  override func setUp() {
    super.setUp()
    root = FileOperationsTestSupport.makeTempDir()
  }

  override func tearDown() {
    FileOperationsTestSupport.cleanup(root)
    root = nil
    super.tearDown()
  }

  @discardableResult
  private func put(_ contents: String, _ path: String) -> URL {
    FileOperationsTestSupport.write(contents, to: root.appendingPathComponent(path))
  }

  private func contents(_ path: String) -> String? {
    FileOperationsTestSupport.contents(root.appendingPathComponent(path))
  }

  private func exists(_ path: String) -> Bool {
    FileOperationsTestSupport.exists(root.appendingPathComponent(path))
  }

  // MARK: - Trash

  func testTrashCarriesEveryConflictCopyWithItsPhoto() async throws {
    let source = put("pixels", "2024/photo.dng")
    put("<canonical/>", "2024/photo.xmp")
    put("<mac/>", "2024/\(mac)")
    put("<ipad/>", "2024/\(numbered)")

    _ = try await LocalFileOperations.trashToMapleFolder(source, libraryRoot: root)

    XCTAssertFalse(exists("2024/\(mac)"))
    XCTAssertFalse(exists("2024/\(numbered)"))
    XCTAssertEqual(contents(".maple/trash/2024/\(mac)"), "<mac/>")
    XCTAssertEqual(contents(".maple/trash/2024/\(numbered)"), "<ipad/>")
    XCTAssertEqual(contents(".maple/trash/2024/photo.xmp"), "<canonical/>")
  }

  func testRestoreBringsTheTrashedConflictCopiesBack() async throws {
    let source = put("pixels", "photo.dng")
    put("<mac/>", mac)
    let outcome = try await LocalFileOperations.trashToMapleFolder(source, libraryRoot: root)

    _ = try await LocalFileOperations.restoreFromMapleTrash(
      URL(fileURLWithPath: outcome.primaryPath), libraryRoot: root)

    XCTAssertEqual(contents("photo.dng"), "pixels")
    XCTAssertEqual(contents(mac), "<mac/>")
    XCTAssertFalse(exists(".maple/trash/\(mac)"))
  }

  func testTrashedTwiceFollowsTheCollisionSuffix() async throws {
    put("first", "photo.dng")
    put("<first/>", mac)
    _ = try await LocalFileOperations.trashToMapleFolder(
      root.appendingPathComponent("photo.dng"), libraryRoot: root)
    put("second", "photo.dng")
    put("<second/>", mac)

    let outcome = try await LocalFileOperations.trashToMapleFolder(
      root.appendingPathComponent("photo.dng"), libraryRoot: root)

    XCTAssertEqual(URL(fileURLWithPath: outcome.primaryPath).lastPathComponent, "photo.1.dng")
    XCTAssertEqual(contents(".maple/trash/\(mac)"), "<first/>")
    XCTAssertEqual(contents(".maple/trash/photo.1 (conflict from Mac).xmp"), "<second/>")
  }

  func testPurgeRemovesTheTrashedConflictCopiesWithThePhoto() async throws {
    let source = put("pixels", "photo.dng")
    put("<mac/>", mac)
    _ = try await LocalFileOperations.trashToMapleFolder(source, libraryRoot: root)
    let item = try XCTUnwrap(LocalFileOperations.listMapleTrash(libraryRoot: root).first)

    try LocalFileOperations.permanentlyDeleteFromMapleTrash(item, libraryRoot: root)

    XCTAssertFalse(exists(".maple/trash/\(mac)"))
  }

  func testAConflictCopyBesideItsPhotoInTrashIsNotSweptAsAnOrphan() throws {
    let longAgo = Date().addingTimeInterval(-40 * 86_400)
    let photo = put("pixels", ".maple/trash/photo.dng")
    let copy = put("<mac/>", ".maple/trash/\(mac)")
    try FileManager.default.setAttributes(
      [.modificationDate: longAgo], ofItemAtPath: copy.path)
    LocalFileOperations.writeTrashedMarker(forItemAt: photo, date: Date())

    LocalFileOperations.sweepExpiredMapleTrash(libraryRoot: root, olderThanDays: 30)

    XCTAssertTrue(FileOperationsTestSupport.exists(copy))
  }

  // MARK: - Move and rename

  func testMoveCarriesConflictCopiesToTheDestination() async throws {
    let source = put("pixels", "Source/photo.dng")
    put("<mac/>", "Source/\(mac)")
    put("<ipad/>", "Source/\(numbered)")

    let outcome = try await LocalFileOperations.relocate(
      source, to: root.appendingPathComponent("Album"), mode: .move)

    XCTAssertEqual(outcome.primaryPath, root.appendingPathComponent("Album/photo.dng").path)
    XCTAssertEqual(contents("Album/\(mac)"), "<mac/>")
    XCTAssertEqual(contents("Album/\(numbered)"), "<ipad/>")
    XCTAssertFalse(exists("Source/\(mac)"))
    XCTAssertFalse(exists("Source/\(numbered)"))
  }

  func testRenameCarriesConflictCopiesUnderTheNewStem() async throws {
    let source = put("pixels", "photo.dng")
    put("<mac/>", mac)

    _ = try await LocalFileOperations.relocate(
      source, to: root, newBasename: "renamed.dng", mode: .move, collision: .fail)

    XCTAssertEqual(contents("renamed (conflict from Mac).xmp"), "<mac/>")
    XCTAssertFalse(exists(mac))
  }

  func testCopyLeavesTheSourceConflictCopiesInPlace() async throws {
    let source = put("pixels", "Source/photo.dng")
    put("<mac/>", "Source/\(mac)")

    _ = try await LocalFileOperations.relocate(
      source, to: root.appendingPathComponent("Album"), mode: .copy)

    XCTAssertEqual(contents("Album/\(mac)"), "<mac/>")
    XCTAssertEqual(contents("Source/\(mac)"), "<mac/>")
  }

  func testAnotherPhotosOwnSidecarIsNotCarried() async throws {
    let source = put("pixels", "Source/photo.dng")
    put("other pixels", "Source/photo (conflict from Mac).dng")
    put("<other photo's edit/>", "Source/\(mac)")

    _ = try await LocalFileOperations.relocate(
      source, to: root.appendingPathComponent("Album"), mode: .move)

    XCTAssertEqual(contents("Source/\(mac)"), "<other photo's edit/>")
    XCTAssertFalse(exists("Album/\(mac)"))
  }

  func testCaseOnlyRenameCarriesConflictCopies() async throws {
    let source = put("pixels", "photo.dng")
    put("<mac/>", mac)

    _ = try await LocalFileOperations.relocate(
      source, to: root, newBasename: "PHOTO.dng", mode: .move)

    let listing = try FileManager.default.contentsOfDirectory(atPath: root.path)
    XCTAssertTrue(listing.contains("PHOTO (conflict from Mac).xmp"))
    XCTAssertFalse(listing.contains(mac))
  }

  // MARK: - Shared stem (RAW + JPEG)

  func testMovingOneHalfOfAPairCopiesTheConflictCopyAndLeavesItForTheOther() async throws {
    let raw = put("raw", "Source/photo.dng")
    put("jpeg", "Source/photo.jpg")
    put("<mac/>", "Source/\(mac)")

    _ = try await LocalFileOperations.relocate(
      raw, to: root.appendingPathComponent("Album"), mode: .move)

    XCTAssertEqual(contents("Source/\(mac)"), "<mac/>")
    XCTAssertEqual(contents("Album/\(mac)"), "<mac/>")
  }

  func testTheLastHalfOfAPairTakesTheConflictCopyAndJoinsTheIdenticalOne() async throws {
    let raw = put("raw", "Source/photo.dng")
    let jpeg = put("jpeg", "Source/photo.jpg")
    put("<mac/>", "Source/\(mac)")
    let album = root.appendingPathComponent("Album")

    _ = try await LocalFileOperations.relocate(raw, to: album, mode: .move)
    let outcome = try await LocalFileOperations.relocate(jpeg, to: album, mode: .move)

    XCTAssertEqual(URL(fileURLWithPath: outcome.primaryPath).lastPathComponent, "photo.jpg")
    XCTAssertFalse(exists("Source/\(mac)"))
    XCTAssertEqual(contents("Album/\(mac)"), "<mac/>")
    XCTAssertFalse(exists("Album/photo.1 (conflict from Mac).xmp"))
  }

  func testTrashingOneHalfOfAPairKeepsTheConflictCopyForTheOther() async throws {
    let raw = put("raw", "photo.dng")
    put("jpeg", "photo.jpg")
    put("<mac/>", mac)

    _ = try await LocalFileOperations.trashToMapleFolder(raw, libraryRoot: root)

    XCTAssertEqual(contents(mac), "<mac/>")
    XCTAssertEqual(contents(".maple/trash/\(mac)"), "<mac/>")
  }

  // MARK: - Collisions and failure

  func testAnUnrelatedConflictCopyAtTheDestinationCollidesTheWholePhoto() async throws {
    let source = put("pixels", "Source/photo.dng")
    put("<mine/>", "Source/\(mac)")
    let held = put("<theirs/>", "Album/\(mac)")

    do {
      _ = try await LocalFileOperations.relocate(
        source, to: root.appendingPathComponent("Album"), mode: .move, collision: .fail)
      XCTFail("an occupied conflict copy name must collide")
    } catch FileOperationError.destinationExists {
    }

    XCTAssertEqual(contents("Source/photo.dng"), "pixels")
    XCTAssertEqual(contents("Source/\(mac)"), "<mine/>")
    XCTAssertEqual(FileOperationsTestSupport.contents(held), "<theirs/>")
    XCTAssertFalse(exists("Album/photo.dng"))
  }

  func testAutoSuffixSkipsAStemWhoseConflictCopyNameIsTaken() async throws {
    let source = put("pixels", "Source/photo.dng")
    put("<mine/>", "Source/\(mac)")
    put("<theirs/>", "Album/\(mac)")

    let outcome = try await LocalFileOperations.relocate(
      source, to: root.appendingPathComponent("Album"), mode: .move, collision: .autoSuffix)

    XCTAssertEqual(URL(fileURLWithPath: outcome.primaryPath).lastPathComponent, "photo.1.dng")
    XCTAssertEqual(contents("Album/\(mac)"), "<theirs/>")
    XCTAssertEqual(contents("Album/photo.1 (conflict from Mac).xmp"), "<mine/>")
  }

  func testAConflictCopyNamedLikeAnotherPhotosSidecarCollides() async throws {
    let source = put("pixels", "Source/photo.dng")
    put("<mine/>", "Source/\(mac)")
    put("other pixels", "Album/photo (conflict from Mac).dng")

    do {
      _ = try await LocalFileOperations.relocate(
        source, to: root.appendingPathComponent("Album"), mode: .move, collision: .fail)
      XCTFail("the copy would become the other photo's edit")
    } catch FileOperationError.destinationExists {
    }

    XCTAssertFalse(exists("Album/\(mac)"))
    XCTAssertEqual(contents("Source/\(mac)"), "<mine/>")
  }

  func testAnUnreadableConflictCopyFailsTheMoveAndLeavesEverythingAsItWas() async throws {
    try XCTSkipIf(geteuid() == 0, "root reads a file whatever its mode")
    let source = put("pixels", "Source/photo.dng")
    put("<canonical/>", "Source/photo.xmp")
    let unreadable = put("<mac/>", "Source/\(mac)")
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: unreadable.path)
    defer {
      try? FileManager.default.setAttributes(
        [.posixPermissions: 0o644], ofItemAtPath: unreadable.path)
    }

    do {
      _ = try await LocalFileOperations.relocate(
        source, to: root.appendingPathComponent("Album"), mode: .move)
      XCTFail("a conflict copy that cannot be copied must stop the move")
    } catch {
    }

    XCTAssertEqual(contents("Source/photo.dng"), "pixels")
    XCTAssertEqual(contents("Source/photo.xmp"), "<canonical/>")
    XCTAssertTrue(exists("Source/\(mac)"))
    let album = (try? FileManager.default.contentsOfDirectory(atPath: root.path + "/Album")) ?? []
    XCTAssertEqual(album, [])
  }

  func testAnUnlistableDestinationStopsTheMoveWithNothingChanged() async throws {
    try XCTSkipIf(geteuid() == 0, "root lists a folder whatever its mode")
    let source = put("pixels", "Source/photo.dng")
    put("<mine/>", "Source/\(mac)")
    let album = root.appendingPathComponent("Album")
    try FileManager.default.createDirectory(at: album, withIntermediateDirectories: true)
    try FileManager.default.setAttributes([.posixPermissions: 0o300], ofItemAtPath: album.path)
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: album.path)
    }

    do {
      _ = try await LocalFileOperations.relocate(source, to: album, mode: .move)
      XCTFail("a destination that cannot be listed must stop the move")
    } catch FileOperationError.underlying(let message) {
      XCTAssertTrue(message.contains("Album"))
    }

    XCTAssertEqual(contents("Source/photo.dng"), "pixels")
    XCTAssertEqual(contents("Source/\(mac)"), "<mine/>")
  }

  func testReplaceRefusesADestinationThatHoldsAnotherPhotosConflictCopy() async throws {
    let source = put("incoming", "Source/photo.dng")
    put("<mine/>", "Source/\(mac)")
    put("existing", "Album/photo.dng")
    put("<theirs/>", "Album/\(mac)")

    do {
      _ = try await LocalFileOperations.relocate(
        source, to: root.appendingPathComponent("Album"), mode: .move, collision: .replace)
      XCTFail("Replace must not attach the old photo's conflict copy to this photo")
    } catch FileOperationError.destinationExists {
    }

    XCTAssertEqual(contents("Source/photo.dng"), "incoming")
    XCTAssertEqual(contents("Source/\(mac)"), "<mine/>")
    XCTAssertEqual(contents("Album/photo.dng"), "existing")
    XCTAssertEqual(contents("Album/\(mac)"), "<theirs/>")
  }

  func testReplaceJoinsAnIdenticalConflictCopyAtTheDestination() async throws {
    let source = put("incoming", "Source/photo.dng")
    put("<same/>", "Source/\(mac)")
    put("existing", "Album/photo.dng")
    put("<same/>", "Album/\(mac)")

    _ = try await LocalFileOperations.relocate(
      source, to: root.appendingPathComponent("Album"), mode: .move, collision: .replace)

    XCTAssertEqual(contents("Album/photo.dng"), "incoming")
    XCTAssertEqual(contents("Album/\(mac)"), "<same/>")
    XCTAssertFalse(exists("Source/\(mac)"))
  }

  func testAPhotoNamedLikeAConflictCopyKeepsItsOwnSidecarAndCarriesItsRealCopy() async throws {
    let source = put("pixels", "Source/A (conflict from B).dng")
    put("<own/>", "Source/A (conflict from B).xmp")
    put("<copy/>", "Source/A (conflict from B) (conflict from Mac).xmp")
    put("other", "Source/A.dng")
    put("<a/>", "Source/A.xmp")

    _ = try await LocalFileOperations.relocate(
      source, to: root.appendingPathComponent("Album"), mode: .move)

    XCTAssertEqual(contents("Album/A (conflict from B).xmp"), "<own/>")
    XCTAssertEqual(contents("Album/A (conflict from B) (conflict from Mac).xmp"), "<copy/>")
    XCTAssertEqual(contents("Source/A.xmp"), "<a/>")
    XCTAssertFalse(exists("Album/A.xmp"))
  }

  // MARK: - Canonically equivalent names

  private func listing(_ folder: String) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(folder).path))
      ?? []).filter { $0 != ".maple" }.map { $0.precomposedStringWithCanonicalMapping }
  }

  func testADecomposedCopyFollowsAComposedPhoto() async throws {
    let source = put("pixels", "Source/caf\u{e9}.dng")
    put("<copy/>", "Source/cafe\u{301} (conflict from Mac).xmp")

    _ = try await LocalFileOperations.relocate(
      source, to: root.appendingPathComponent("Album"), mode: .move)

    XCTAssertTrue(listing("Album").contains("caf\u{e9} (conflict from Mac).xmp"))
    XCTAssertEqual(listing("Source"), [])
  }

  func testAComposedCopyFollowsADecomposedPhoto() async throws {
    let source = put("pixels", "Source/cafe\u{301}.dng")
    put("<copy/>", "Source/caf\u{e9} (conflict from Mac).xmp")

    _ = try await LocalFileOperations.relocate(
      source, to: root.appendingPathComponent("Album"), mode: .move)

    XCTAssertTrue(listing("Album").contains("caf\u{e9} (conflict from Mac).xmp"))
    XCTAssertEqual(listing("Source"), [])
  }

  func testADecomposedCopyBesideItsPhotoInTrashIsNotAnOrphan() {
    XCTAssertFalse(
      SidecarOwnership.isOrphanedSidecar(
        "cafe\u{301} (conflict from Mac).xmp", siblingNames: ["caf\u{e9}.dng"]))
  }

  // MARK: - macOS Trash

  #if os(macOS)
    func testTrashToOSTrashMovesConflictCopiesWithThePhoto() async throws {
      let stem = "qa-\(UUID().uuidString.lowercased())"
      let source = put("pixels", "\(stem).dng")
      let copy = put("<mac/>", "\(stem) (conflict from Mac).xmp")

      let outcome = try await LocalFileOperations.trashToOSTrash(source)
      let trashedCopy = URL(fileURLWithPath: outcome.primaryPath)
        .deletingLastPathComponent().appendingPathComponent(copy.lastPathComponent)
      defer {
        try? FileManager.default.removeItem(atPath: outcome.primaryPath)
        try? FileManager.default.removeItem(at: trashedCopy)
      }

      XCTAssertFalse(FileOperationsTestSupport.exists(copy))
      XCTAssertTrue(FileOperationsTestSupport.exists(trashedCopy))
    }

    func testTrashToOSTrashCopiesConflictCopiesStillSharedWithASibling() async throws {
      let stem = "qa-\(UUID().uuidString.lowercased())"
      let source = put("raw", "\(stem).dng")
      let sibling = put("jpeg", "\(stem).jpg")
      let copy = put("<mac/>", "\(stem) (conflict from Mac).xmp")

      let outcome = try await LocalFileOperations.trashToOSTrash(source)
      let trashedCopy = URL(fileURLWithPath: outcome.primaryPath)
        .deletingLastPathComponent().appendingPathComponent(copy.lastPathComponent)
      defer {
        try? FileManager.default.removeItem(atPath: outcome.primaryPath)
        try? FileManager.default.removeItem(at: trashedCopy)
      }

      XCTAssertTrue(FileOperationsTestSupport.exists(sibling))
      XCTAssertTrue(FileOperationsTestSupport.exists(copy))
      XCTAssertTrue(FileOperationsTestSupport.exists(trashedCopy))
    }
  #endif
}
