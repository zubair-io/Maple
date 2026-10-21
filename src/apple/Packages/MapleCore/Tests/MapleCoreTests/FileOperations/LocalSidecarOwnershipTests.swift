// LocalSidecarOwnershipTests.swift — the shared-sidecar ownership rule
// (#4707; docs/xmp-canonical-format.md § "Moving, renaming and trashing a
// photo") against the local engine, on real temp directories. Every existing
// `.xmp` a scenario must not touch is asserted byte-identical.

import XCTest

@testable import MapleCore

final class LocalSidecarOwnershipTests: XCTestCase {
  private var root: URL!

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
  private func write(_ contents: String, _ rel: String) -> URL {
    FileOperationsTestSupport.write(contents, to: root.appendingPathComponent(rel))
  }

  private func url(_ rel: String) -> URL { root.appendingPathComponent(rel) }

  private func tree() throws -> [String: String] {
    let fm = FileManager.default
    let base = root.resolvingSymlinksInPath().standardizedFileURL
    let enumerator = try XCTUnwrap(
      fm.enumerator(at: base, includingPropertiesForKeys: [.isRegularFileKey]))
    let files = try enumerator.compactMap { item -> (String, String)? in
      guard let file = item as? URL,
        try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true
      else { return nil }
      let rel = file.resolvingSymlinksInPath().standardizedFileURL.pathComponents
        .dropFirst(base.pathComponents.count)
      guard rel.filter({ $0 == ".maple" }).count <= (rel.contains("trash") ? 1 : 0) else {
        return nil
      }
      guard !rel.last!.hasPrefix(".") else { return nil }
      return (rel.joined(separator: "/"), FileOperationsTestSupport.contents(file) ?? "<binary>")
    }
    return Dictionary(uniqueKeysWithValues: files)
  }

  // MARK: - Rule 1: a shared sidecar is copied, never taken

  func testMovingTheRawOfARawJpegPairCopiesTheSharedSidecar() async throws {
    let raw = write("raw", "Source/IMG_1.CR3")
    write("jpg", "Source/IMG_1.JPG")
    write("<shared/>", "Source/IMG_1.xmp")

    let outcome = try await LocalFileOperations.relocate(
      raw, to: url("Album"), mode: .move, collision: .autoSuffix)

    XCTAssertTrue(outcome.sidecarFollowed)
    XCTAssertFalse(outcome.renamedDueToCollision)
    XCTAssertEqual(
      try tree(),
      [
        "Album/IMG_1.CR3": "raw", "Album/IMG_1.xmp": "<shared/>",
        "Source/IMG_1.JPG": "jpg", "Source/IMG_1.xmp": "<shared/>",
      ])
  }

  func testRenamingTheRawOfARawJpegPairCopiesTheSharedSidecar() async throws {
    let raw = write("raw", "IMG_1.CR3")
    write("jpg", "IMG_1.JPG")
    write("<shared/>", "IMG_1.xmp")

    let outcome = try await LocalFileOperations.relocate(
      raw, to: root, newBasename: "IMG_2.CR3", mode: .move, collision: .fail)

    XCTAssertTrue(outcome.sidecarFollowed)
    XCTAssertEqual(
      try tree(),
      [
        "IMG_1.JPG": "jpg", "IMG_1.xmp": "<shared/>",
        "IMG_2.CR3": "raw", "IMG_2.xmp": "<shared/>",
      ])
  }

  func testTrashingTheRawOfARawJpegPairToTheMapleTrashCopiesTheSharedSidecar() async throws {
    let raw = write("raw", "Shoot/IMG_1.CR3")
    write("jpg", "Shoot/IMG_1.JPG")
    write("<shared/>", "Shoot/IMG_1.xmp")

    let outcome = try await LocalFileOperations.trashToMapleFolder(raw, libraryRoot: root)

    XCTAssertTrue(outcome.sidecarFollowed)
    let files = try tree()
    XCTAssertEqual(files["Shoot/IMG_1.JPG"], "jpg")
    XCTAssertEqual(files["Shoot/IMG_1.xmp"], "<shared/>")
    XCTAssertNil(files["Shoot/IMG_1.CR3"])
    XCTAssertEqual(files[".maple/trash/Shoot/IMG_1.CR3"], "raw")
    XCTAssertEqual(files[".maple/trash/Shoot/IMG_1.xmp"], "<shared/>")
  }

  #if os(macOS)
    func testTrashingTheRawOfARawJpegPairToTheOSTrashKeepsTheSharedSidecar() async throws {
      let raw = write("raw", "IMG_1.CR3")
      write("jpg", "IMG_1.JPG")
      write("<shared/>", "IMG_1.xmp")

      let outcome = try await LocalFileOperations.trashToOSTrash(raw)
      defer {
        try? FileManager.default.removeItem(atPath: outcome.primaryPath)
        if let sidecarPath = outcome.sidecarPath {
          try? FileManager.default.removeItem(atPath: sidecarPath)
        }
      }

      XCTAssertEqual(try tree(), ["IMG_1.JPG": "jpg", "IMG_1.xmp": "<shared/>"])
      XCTAssertTrue(outcome.sidecarFollowed)
      let trashedSidecar = try XCTUnwrap(outcome.sidecarPath)
      XCTAssertEqual(URL(fileURLWithPath: trashedSidecar).pathExtension, "xmp")
      XCTAssertEqual(
        FileOperationsTestSupport.contents(URL(fileURLWithPath: trashedSidecar)), "<shared/>")
    }
  #endif

  func testALivePhotoClipNeverSharesTheStillsSidecar() async throws {
    let clip = write("frames", "Source/IMG_1.MOV")
    write("still", "Source/IMG_1.HEIC")
    write("<clip/>", "Source/IMG_1.MOV.xmp")
    write("<still/>", "Source/IMG_1.xmp")

    _ = try await LocalFileOperations.relocate(
      clip, to: url("Album"), mode: .move, collision: .autoSuffix)

    XCTAssertEqual(
      try tree(),
      [
        "Album/IMG_1.MOV": "frames", "Album/IMG_1.MOV.xmp": "<clip/>",
        "Source/IMG_1.HEIC": "still", "Source/IMG_1.xmp": "<still/>",
      ])
  }

  // MARK: - Rule 3: a sidecar that maps onto itself is left alone

  func testExtensionOnlyRenameKeepsTheSoleSidecar() async throws {
    let raw = write("raw", "X.CR3")
    write("<only/>", "X.xmp")

    let outcome = try await LocalFileOperations.relocate(
      raw, to: root, newBasename: "X.DNG", mode: .move, collision: .fail)

    XCTAssertTrue(outcome.sidecarFollowed)
    XCTAssertEqual(outcome.sidecarPath, url("X.xmp").path)
    XCTAssertEqual(try tree(), ["X.DNG": "raw", "X.xmp": "<only/>"])
  }

  func testExtensionOnlyRenameUnderReplaceKeepsTheSoleSidecar() async throws {
    let raw = write("raw", "X.CR3")
    write("old", "X.DNG")
    write("<only/>", "X.xmp")

    _ = try await LocalFileOperations.relocate(
      raw, to: root, newBasename: "X.DNG", mode: .move, collision: .replace)

    XCTAssertEqual(try tree(), ["X.DNG": "raw", "X.xmp": "<only/>"])
  }

  // MARK: - Rule 2: an occupied destination sidecar is a whole-asset collision

  private func seedDestinationSibling() -> URL {
    let raw = write("new", "Source/IMG_1.CR3")
    write("<new/>", "Source/IMG_1.xmp")
    write("jpg", "Album/IMG_1.JPG")
    write("<sibling/>", "Album/IMG_1.xmp")
    return raw
  }

  func testDestinationSiblingSidecarForcesAutoSuffix() async throws {
    let raw = seedDestinationSibling()

    let outcome = try await LocalFileOperations.relocate(
      raw, to: url("Album"), mode: .move, collision: .autoSuffix)

    XCTAssertTrue(outcome.renamedDueToCollision)
    XCTAssertEqual(
      try tree(),
      [
        "Album/IMG_1.1.CR3": "new", "Album/IMG_1.1.xmp": "<new/>",
        "Album/IMG_1.JPG": "jpg", "Album/IMG_1.xmp": "<sibling/>",
      ])
  }

  func testDestinationSiblingSidecarFailsUnderFail() async throws {
    let raw = seedDestinationSibling()
    let before = try tree()

    do {
      _ = try await LocalFileOperations.relocate(
        raw, to: url("Album"), mode: .move, collision: .fail)
      XCTFail("an occupied destination sidecar must collide under .fail")
    } catch FileOperationError.destinationExists {}

    XCTAssertEqual(try tree(), before)
  }

  func testReplaceRefusesASidecarOwnedByADestinationSibling() async throws {
    let raw = seedDestinationSibling()
    write("old", "Album/IMG_1.CR3")
    let before = try tree()

    do {
      _ = try await LocalFileOperations.relocate(
        raw, to: url("Album"), mode: .move, collision: .replace)
      XCTFail("replace must not overwrite a sidecar a destination sibling still uses")
    } catch FileOperationError.destinationExists {}

    XCTAssertEqual(try tree(), before)
  }

  func testReplaceKeepsASiblingOwnedSidecarWhenIncomingHasNone() async throws {
    let raw = write("new", "Source/IMG_1.CR3")
    write("old", "Album/IMG_1.CR3")
    write("jpg", "Album/IMG_1.JPG")
    write("<sibling/>", "Album/IMG_1.xmp")

    let outcome = try await LocalFileOperations.relocate(
      raw, to: url("Album"), mode: .move, collision: .replace)

    XCTAssertFalse(outcome.sidecarFollowed)
    XCTAssertEqual(
      try tree(),
      ["Album/IMG_1.CR3": "new", "Album/IMG_1.JPG": "jpg", "Album/IMG_1.xmp": "<sibling/>"])
  }

  func testReplaceStillRemovesAnOrphanSidecarWhenIncomingHasNone() async throws {
    let raw = write("new", "Source/IMG_1.CR3")
    write("old", "Album/IMG_1.CR3")
    write("<stale/>", "Album/IMG_1.xmp")

    _ = try await LocalFileOperations.relocate(
      raw, to: url("Album"), mode: .move, collision: .replace)

    XCTAssertEqual(try tree(), ["Album/IMG_1.CR3": "new"])
  }

  func testOrphanDestinationSidecarForcesAutoSuffixWithoutOwnSidecar() async throws {
    let raw = write("new", "Source/IMG_1.CR3")
    write("<orphan/>", "Album/IMG_1.xmp")

    let outcome = try await LocalFileOperations.relocate(
      raw, to: url("Album"), mode: .move, collision: .autoSuffix)

    XCTAssertTrue(outcome.renamedDueToCollision)
    XCTAssertFalse(outcome.sidecarFollowed)
    XCTAssertEqual(try tree(), ["Album/IMG_1.1.CR3": "new", "Album/IMG_1.xmp": "<orphan/>"])
  }

  // MARK: - Restore and external rename

  func testRestoringOneOfATrashedRawJpegPairLeavesTheSharedSidecarInTheTrash() async throws {
    let trashed = write("raw", ".maple/trash/Shoot/IMG_1.CR3")
    write("jpg", ".maple/trash/Shoot/IMG_1.JPG")
    write("<shared/>", ".maple/trash/Shoot/IMG_1.xmp")
    try FileManager.default.createDirectory(
      at: url("Shoot"), withIntermediateDirectories: true)

    let outcome = try await LocalFileOperations.restoreFromMapleTrash(trashed, libraryRoot: root)

    XCTAssertTrue(outcome.sidecarFollowed)
    let files = try tree()
    XCTAssertEqual(files["Shoot/IMG_1.CR3"], "raw")
    XCTAssertEqual(files["Shoot/IMG_1.xmp"], "<shared/>")
    XCTAssertEqual(files[".maple/trash/Shoot/IMG_1.JPG"], "jpg")
    XCTAssertEqual(files[".maple/trash/Shoot/IMG_1.xmp"], "<shared/>")
  }

  func testExternalRenameOfTheRawOfARawJpegPairCopiesTheSharedSidecar() async throws {
    write("raw", "IMG_2.CR3")
    write("jpg", "IMG_1.JPG")
    write("<shared/>", "IMG_1.xmp")

    let applied = await LocalFileOperations.applyExternalRename(
      oldPrimaryPath: url("IMG_1.CR3").path, newPrimaryPath: url("IMG_2.CR3").path)

    XCTAssertTrue(applied)
    XCTAssertEqual(
      try tree(),
      [
        "IMG_1.JPG": "jpg", "IMG_1.xmp": "<shared/>",
        "IMG_2.CR3": "raw", "IMG_2.xmp": "<shared/>",
      ])
  }

  func testExternalExtensionOnlyRenameKeepsTheSoleSidecar() async throws {
    write("raw", "X.DNG")
    write("<only/>", "X.xmp")

    let applied = await LocalFileOperations.applyExternalRename(
      oldPrimaryPath: url("X.CR3").path, newPrimaryPath: url("X.DNG").path)

    XCTAssertTrue(applied)
    XCTAssertEqual(try tree(), ["X.DNG": "raw", "X.xmp": "<only/>"])
  }

  // MARK: - Stem rule

  func testStemRuleMatchesOnlySameStemNonSidecarFiles() {
    let names = ["IMG_1.JPG", "IMG_1.xmp", ".IMG_1.CR3", "IMG_1.CR3.tmp.42-ab", "IMG_1.MOV"]
    XCTAssertTrue(
      SidecarOwnership.stemClaimedBySibling(primaryPath: "/d/IMG_1.CR3", siblingNames: names))
    XCTAssertFalse(
      SidecarOwnership.stemClaimedBySibling(
        primaryPath: "/d/IMG_1.CR3", siblingNames: Array(names.dropFirst())))
    XCTAssertFalse(
      SidecarOwnership.stemClaimedBySibling(
        primaryPath: "/d/IMG_1.CR3", siblingNames: ["img_1.jpg"], excluding: ["/d/img_1.jpg"]))
    XCTAssertFalse(
      SidecarOwnership.stemClaimedBySibling(
        primaryPath: "/d/IMG_1.CR3", siblingNames: ["img_1.jpg"], excluding: ["/d/IMG_1.JPG"]),
      "on a case-folding volume a case-different exclusion names the same file")
    XCTAssertTrue(
      SidecarOwnership.stemClaimedBySibling(
        primaryPath: "/d/IMG_1.CR3", siblingNames: ["IMG_1.JPG"], excluding: ["/d/img_1.jpg"],
        foldsCase: false),
      "on a case-sensitive volume a case-different exclusion is a separate file")
  }

  func testAnUnlistableFolderCountsAsClaimed() {
    XCTAssertTrue(
      SidecarOwnership.localStemClaimedBySibling(url("missing-folder/IMG_1.CR3")))
  }

  func testSameFileMeansFileIdentityNotACaseInsensitiveStringCompare() {
    let sidecar = write("<x/>", "X.xmp")
    write("<y/>", "Y.xmp")
    let folds = FileManager.default.fileExists(atPath: url("x.XMP").path)

    XCTAssertTrue(SidecarOwnership.sameLocalFile(sidecar.path, sidecar.path))
    XCTAssertEqual(SidecarOwnership.sameLocalFile(sidecar.path, url("x.XMP").path), folds)
    XCTAssertFalse(SidecarOwnership.sameLocalFile(sidecar.path, url("Y.xmp").path))
    XCTAssertFalse(SidecarOwnership.sameLocalFile(url("missing.xmp").path, url("MISSING.xmp").path))
  }

  // MARK: - Rule 2 exception: an identical destination sidecar is joined

  func testMovingBothHalvesOfARawJpegPairKeepsThemOnOneSidecar() async throws {
    let raw = write("raw", "Source/IMG_1.CR3")
    let jpg = write("jpg", "Source/IMG_1.JPG")
    write("<shared/>", "Source/IMG_1.xmp")

    _ = try await LocalFileOperations.relocate(
      raw, to: url("Album"), mode: .move, collision: .autoSuffix)
    let second = try await LocalFileOperations.relocate(
      jpg, to: url("Album"), mode: .move, collision: .autoSuffix)

    XCTAssertFalse(second.renamedDueToCollision)
    XCTAssertTrue(second.sidecarFollowed)
    XCTAssertEqual(
      try tree(),
      ["Album/IMG_1.CR3": "raw", "Album/IMG_1.JPG": "jpg", "Album/IMG_1.xmp": "<shared/>"])
  }

  func testJoiningAnIdenticalSidecarUnderFailIsNotACollision() async throws {
    let jpg = write("jpg", "Source/IMG_1.JPG")
    write("<shared/>", "Source/IMG_1.xmp")
    write("raw", "Album/IMG_1.CR3")
    write("<shared/>", "Album/IMG_1.xmp")

    let outcome = try await LocalFileOperations.relocate(
      jpg, to: url("Album"), mode: .move, collision: .fail)

    XCTAssertEqual(outcome.sidecarPath, url("Album/IMG_1.xmp").path)
    XCTAssertEqual(
      try tree(),
      ["Album/IMG_1.CR3": "raw", "Album/IMG_1.JPG": "jpg", "Album/IMG_1.xmp": "<shared/>"])
  }

  // MARK: - File identity, not spelling

  func testExtensionOnlyRenameThroughASymlinkedFolderKeepsTheSoleSidecar() async throws {
    let raw = write("raw", "real/X.CR3")
    write("<only/>", "real/X.xmp")
    try FileManager.default.createSymbolicLink(at: url("alias"), withDestinationURL: url("real"))

    let outcome = try await LocalFileOperations.relocate(
      raw, to: url("alias"), newBasename: "X.DNG", mode: .move, collision: .fail)

    XCTAssertTrue(outcome.sidecarFollowed)
    XCTAssertEqual(try tree(), ["real/X.DNG": "raw", "real/X.xmp": "<only/>"])
  }

  private func requireCaseFoldingRoot() throws {
    guard SidecarOwnership.localVolumeFoldsCase(root) else {
      throw XCTSkip("needs a case-insensitive temp volume")
    }
  }

  func testReplacingACaseDifferentNameClearsTheReplacedPhotosStaleSidecar() async throws {
    try requireCaseFoldingRoot()
    let incoming = write("new", "Source/img.CR3")
    write("old", "Album/IMG.CR3")
    write("<stale/>", "Album/IMG.xmp")

    let outcome = try await LocalFileOperations.relocate(
      incoming, to: url("Album"), mode: .move, collision: .replace)

    XCTAssertFalse(outcome.sidecarFollowed)
    XCTAssertEqual(FileOperationsTestSupport.contents(url("Album/IMG.CR3")), "new")
    XCTAssertFalse(FileManager.default.fileExists(atPath: url("Album/IMG.xmp").path))
  }

  func testReplacingACaseDifferentNameCarriesTheIncomingSidecar() async throws {
    try requireCaseFoldingRoot()
    let incoming = write("new", "Source/img.CR3")
    write("<new/>", "Source/img.xmp")
    write("old", "Album/IMG.CR3")
    write("<stale/>", "Album/IMG.xmp")

    let outcome = try await LocalFileOperations.relocate(
      incoming, to: url("Album"), mode: .move, collision: .replace)

    XCTAssertTrue(outcome.sidecarFollowed)
    XCTAssertEqual(FileOperationsTestSupport.contents(url("Album/IMG.CR3")), "new")
    XCTAssertEqual(FileOperationsTestSupport.contents(url("Album/IMG.xmp")), "<new/>")
  }

  // MARK: - Trash lifecycle of a shared sidecar

  private func trashBothHalves() async throws {
    write("raw", "Shoot/IMG_1.CR3")
    write("jpg", "Shoot/IMG_1.JPG")
    write("<shared/>", "Shoot/IMG_1.xmp")
    _ = try await LocalFileOperations.trashToMapleFolder(url("Shoot/IMG_1.CR3"), libraryRoot: root)
    _ = try await LocalFileOperations.trashToMapleFolder(url("Shoot/IMG_1.JPG"), libraryRoot: root)
  }

  private func trashedItem(_ name: String) throws -> TrashedItem {
    try XCTUnwrap(
      LocalFileOperations.listMapleTrash(libraryRoot: root).first {
        URL(fileURLWithPath: $0.primaryPath).lastPathComponent == name
      })
  }

  func testPermanentlyDeletingOneTrashedHalfKeepsTheSidecarTheOtherStillUses() async throws {
    try await trashBothHalves()
    XCTAssertEqual(
      try tree(),
      [
        ".maple/trash/Shoot/IMG_1.CR3": "raw", ".maple/trash/Shoot/IMG_1.JPG": "jpg",
        ".maple/trash/Shoot/IMG_1.xmp": "<shared/>",
      ])

    try LocalFileOperations.permanentlyDeleteFromMapleTrash(
      try trashedItem("IMG_1.CR3"), libraryRoot: root)

    XCTAssertEqual(
      try tree(),
      [".maple/trash/Shoot/IMG_1.JPG": "jpg", ".maple/trash/Shoot/IMG_1.xmp": "<shared/>"])

    try LocalFileOperations.permanentlyDeleteFromMapleTrash(
      try trashedItem("IMG_1.JPG"), libraryRoot: root)

    XCTAssertEqual(try tree(), [:])
  }

  func testRestoringBothTrashedHalvesRejoinsTheSharedSidecar() async throws {
    try await trashBothHalves()

    _ = try await LocalFileOperations.restoreFromMapleTrash(
      url(".maple/trash/Shoot/IMG_1.CR3"), libraryRoot: root)
    let second = try await LocalFileOperations.restoreFromMapleTrash(
      url(".maple/trash/Shoot/IMG_1.JPG"), libraryRoot: root)

    XCTAssertFalse(second.renamedDueToCollision)
    XCTAssertTrue(second.sidecarFollowed)
    XCTAssertEqual(second.sidecarPath.map { URL(fileURLWithPath: $0).lastPathComponent }, "IMG_1.xmp")
    XCTAssertEqual(
      try tree(),
      ["Shoot/IMG_1.CR3": "raw", "Shoot/IMG_1.JPG": "jpg", "Shoot/IMG_1.xmp": "<shared/>"])
  }

  func testRestoringATrashedVideoTakesItsFullNameSidecarOutOfTheTrash() async throws {
    write("frames", "Shoot/clip.MOV")
    write("<clip/>", "Shoot/clip.MOV.xmp")
    _ = try await LocalFileOperations.trashToMapleFolder(url("Shoot/clip.MOV"), libraryRoot: root)
    XCTAssertEqual(
      try tree(),
      [".maple/trash/Shoot/clip.MOV": "frames", ".maple/trash/Shoot/clip.MOV.xmp": "<clip/>"])

    let outcome = try await LocalFileOperations.restoreFromMapleTrash(
      url(".maple/trash/Shoot/clip.MOV"), libraryRoot: root)

    XCTAssertTrue(outcome.sidecarFollowed)
    XCTAssertEqual(try tree(), ["Shoot/clip.MOV": "frames", "Shoot/clip.MOV.xmp": "<clip/>"])
  }

  func testRestoreStillAvoidsADestinationSidecarWithDifferentEdits() async throws {
    let trashed = write("jpg", ".maple/trash/Shoot/IMG_1.JPG")
    write("<trashed/>", ".maple/trash/Shoot/IMG_1.xmp")
    write("raw", "Shoot/IMG_1.CR3")
    write("<live/>", "Shoot/IMG_1.xmp")

    let outcome = try await LocalFileOperations.restoreFromMapleTrash(trashed, libraryRoot: root)

    XCTAssertTrue(outcome.renamedDueToCollision)
    XCTAssertEqual(FileOperationsTestSupport.contents(url("Shoot/IMG_1.xmp")), "<live/>")
    XCTAssertEqual(
      outcome.sidecarPath.flatMap { FileOperationsTestSupport.contents(URL(fileURLWithPath: $0)) },
      "<trashed/>")
  }

  func testExternalMoveOfTheSecondHalfJoinsAnIdenticalDestinationSidecar() async throws {
    write("raw", "Album/IMG_1.CR3")
    write("<shared/>", "Album/IMG_1.xmp")
    write("jpg", "Album/IMG_1.JPG")
    write("<shared/>", "Source/IMG_1.xmp")

    let applied = await LocalFileOperations.applyExternalRename(
      oldPrimaryPath: url("Source/IMG_1.JPG").path, newPrimaryPath: url("Album/IMG_1.JPG").path)

    XCTAssertTrue(applied)
    XCTAssertEqual(
      try tree(),
      ["Album/IMG_1.CR3": "raw", "Album/IMG_1.JPG": "jpg", "Album/IMG_1.xmp": "<shared/>"])
  }

  func testExternalMoveStillDeclinesADestinationSidecarWithDifferentEdits() async throws {
    write("raw", "Album/IMG_1.CR3")
    write("<raw/>", "Album/IMG_1.xmp")
    write("jpg", "Album/IMG_1.JPG")
    write("<jpg/>", "Source/IMG_1.xmp")
    let before = try tree()

    let applied = await LocalFileOperations.applyExternalRename(
      oldPrimaryPath: url("Source/IMG_1.JPG").path, newPrimaryPath: url("Album/IMG_1.JPG").path)

    XCTAssertFalse(applied)
    XCTAssertEqual(try tree(), before)
  }
}
