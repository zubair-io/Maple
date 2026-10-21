// SMBSidecarOwnershipTests.swift — the shared-sidecar ownership rule
// (#4707; docs/xmp-canonical-format.md § "Moving, renaming and trashing a
// photo") against the SMB engine, through the in-memory `FakeSMBTransport`
// the other SMB relocate tests use. Every existing `.xmp` a scenario must not
// touch is asserted byte-identical.

import XCTest

@testable import MapleCore

final class SMBSidecarOwnershipTests: XCTestCase {

  func testMovingTheRawOfARawJpegPairCopiesTheSharedSidecar() async throws {
    let t = FakeSMBTransport()
    await t.seed("raw", at: "/Source/IMG_1.CR3")
    await t.seed("jpg", at: "/Source/IMG_1.JPG")
    await t.seed("<shared/>", at: "/Source/IMG_1.xmp")

    let outcome = try await SMBFileOperations.relocate(
      "/Source/IMG_1.CR3", to: "/Album", mode: .move, transport: t)

    XCTAssertTrue(outcome.sidecarFollowed)
    let files = await t.allFiles()
    XCTAssertEqual(
      files,
      [
        "/Album/IMG_1.CR3": "raw", "/Album/IMG_1.xmp": "<shared/>",
        "/Source/IMG_1.JPG": "jpg", "/Source/IMG_1.xmp": "<shared/>",
      ])
  }

  func testRenamingTheRawOfARawJpegPairCopiesTheSharedSidecar() async throws {
    let t = FakeSMBTransport()
    await t.seed("raw", at: "/Shoot/IMG_1.CR3")
    await t.seed("jpg", at: "/Shoot/IMG_1.JPG")
    await t.seed("<shared/>", at: "/Shoot/IMG_1.xmp")

    _ = try await SMBFileOperations.relocate(
      "/Shoot/IMG_1.CR3", to: "/Shoot", newBasename: "IMG_2.CR3", mode: .move,
      collision: .fail, transport: t)

    let files = await t.allFiles()
    XCTAssertEqual(
      files,
      [
        "/Shoot/IMG_1.JPG": "jpg", "/Shoot/IMG_1.xmp": "<shared/>",
        "/Shoot/IMG_2.CR3": "raw", "/Shoot/IMG_2.xmp": "<shared/>",
      ])
  }

  func testTrashingTheRawOfARawJpegPairCopiesTheSharedSidecar() async throws {
    let t = FakeSMBTransport()
    await t.seed("raw", at: "/Shoot/IMG_1.CR3")
    await t.seed("jpg", at: "/Shoot/IMG_1.JPG")
    await t.seed("<shared/>", at: "/Shoot/IMG_1.xmp")

    let outcome = try await SMBFileOperations.trash("/Shoot/IMG_1.CR3", transport: t)

    XCTAssertTrue(outcome.sidecarFollowed)
    let files = await t.allFiles()
    XCTAssertEqual(files, ["/Shoot/IMG_1.JPG": "jpg", "/Shoot/IMG_1.xmp": "<shared/>"])
    let trashedSidecar = await t.fileContents(at: "/.maple/trash/Shoot/IMG_1.xmp")
    XCTAssertEqual(trashedSidecar, "<shared/>")
  }

  func testExtensionOnlyRenameKeepsTheSoleSidecar() async throws {
    let t = FakeSMBTransport()
    await t.seed("raw", at: "/Shoot/X.CR3")
    await t.seed("<only/>", at: "/Shoot/X.xmp")

    let outcome = try await SMBFileOperations.relocate(
      "/Shoot/X.CR3", to: "/Shoot", newBasename: "X.DNG", mode: .move, collision: .fail,
      transport: t)

    XCTAssertTrue(outcome.sidecarFollowed)
    XCTAssertEqual(outcome.sidecarPath, "/Shoot/X.xmp")
    let files = await t.allFiles()
    XCTAssertEqual(files, ["/Shoot/X.DNG": "raw", "/Shoot/X.xmp": "<only/>"])
  }

  func testExtensionOnlyRenameUnderReplaceKeepsTheSoleSidecar() async throws {
    let t = FakeSMBTransport()
    await t.seed("raw", at: "/Shoot/X.CR3")
    await t.seed("old", at: "/Shoot/X.DNG")
    await t.seed("<only/>", at: "/Shoot/X.xmp")

    _ = try await SMBFileOperations.relocate(
      "/Shoot/X.CR3", to: "/Shoot", newBasename: "X.DNG", mode: .move, collision: .replace,
      transport: t)

    let files = await t.allFiles()
    XCTAssertEqual(files, ["/Shoot/X.DNG": "raw", "/Shoot/X.xmp": "<only/>"])
  }

  func testCaseDifferingSidecarIsADifferentFileOnACaseSensitiveShare() async throws {
    let t = FakeSMBTransport()
    await t.seed("raw", at: "/Shoot/X.CR3")
    await t.seed("<only/>", at: "/Shoot/X.xmp")

    let outcome = try await SMBFileOperations.relocate(
      "/Shoot/X.CR3", to: "/Shoot", newBasename: "x.dng", mode: .move, collision: .fail,
      transport: t)

    XCTAssertEqual(outcome.sidecarPath, "/Shoot/x.xmp")
    let files = await t.allFiles()
    XCTAssertEqual(files, ["/Shoot/x.dng": "raw", "/Shoot/x.xmp": "<only/>"])
  }

  func testCaseOnlyRenameOnACaseSensitiveShareKeepsTheSiblingsSidecar() async throws {
    let t = FakeSMBTransport()
    await t.seed("raw", at: "/Shoot/IMG.CR3")
    await t.seed("jpg", at: "/Shoot/IMG.JPG")
    await t.seed("<shared/>", at: "/Shoot/IMG.xmp")

    let outcome = try await SMBFileOperations.relocate(
      "/Shoot/IMG.CR3", to: "/Shoot", newBasename: "img.cr3", mode: .move, collision: .fail,
      transport: t)

    XCTAssertEqual(outcome.sidecarPath, "/Shoot/img.xmp")
    let files = await t.allFiles()
    XCTAssertEqual(
      files,
      [
        "/Shoot/IMG.JPG": "jpg", "/Shoot/IMG.xmp": "<shared/>",
        "/Shoot/img.cr3": "raw", "/Shoot/img.xmp": "<shared/>",
      ])
  }

  func testCaseOnlyRenameOnACaseSensitiveShareStillTakesAnUnsharedSidecar() async throws {
    let t = FakeSMBTransport()
    await t.seed("raw", at: "/Shoot/IMG.CR3")
    await t.seed("<only/>", at: "/Shoot/IMG.xmp")

    let outcome = try await SMBFileOperations.relocate(
      "/Shoot/IMG.CR3", to: "/Shoot", newBasename: "img.cr3", mode: .move, collision: .fail,
      transport: t)

    XCTAssertEqual(outcome.sidecarPath, "/Shoot/img.xmp")
    let files = await t.allFiles()
    XCTAssertEqual(files, ["/Shoot/img.cr3": "raw", "/Shoot/img.xmp": "<only/>"])
  }

  func testMovingBothHalvesOfARawJpegPairKeepsThemOnOneSidecar() async throws {
    let t = FakeSMBTransport()
    await t.seed("raw", at: "/Source/IMG_1.CR3")
    await t.seed("jpg", at: "/Source/IMG_1.JPG")
    await t.seed("<shared/>", at: "/Source/IMG_1.xmp")

    _ = try await SMBFileOperations.relocate(
      "/Source/IMG_1.CR3", to: "/Album", mode: .move, transport: t)
    let second = try await SMBFileOperations.relocate(
      "/Source/IMG_1.JPG", to: "/Album", mode: .move, transport: t)

    XCTAssertFalse(second.renamedDueToCollision)
    XCTAssertTrue(second.sidecarFollowed)
    let files = await t.allFiles()
    XCTAssertEqual(
      files,
      ["/Album/IMG_1.CR3": "raw", "/Album/IMG_1.JPG": "jpg", "/Album/IMG_1.xmp": "<shared/>"])
  }

  private func seedDestinationSibling(_ t: FakeSMBTransport) async {
    await t.seed("new", at: "/Source/IMG_1.CR3")
    await t.seed("<new/>", at: "/Source/IMG_1.xmp")
    await t.seed("jpg", at: "/Album/IMG_1.JPG")
    await t.seed("<sibling/>", at: "/Album/IMG_1.xmp")
  }

  func testDestinationSiblingSidecarForcesAutoSuffix() async throws {
    let t = FakeSMBTransport()
    await seedDestinationSibling(t)

    let outcome = try await SMBFileOperations.relocate(
      "/Source/IMG_1.CR3", to: "/Album", mode: .move, collision: .autoSuffix, transport: t)

    XCTAssertTrue(outcome.renamedDueToCollision)
    let files = await t.allFiles()
    XCTAssertEqual(
      files,
      [
        "/Album/IMG_1.1.CR3": "new", "/Album/IMG_1.1.xmp": "<new/>",
        "/Album/IMG_1.JPG": "jpg", "/Album/IMG_1.xmp": "<sibling/>",
      ])
  }

  func testDestinationSiblingSidecarFailsUnderFail() async throws {
    let t = FakeSMBTransport()
    await seedDestinationSibling(t)
    let before = await t.allFiles()

    do {
      _ = try await SMBFileOperations.relocate(
        "/Source/IMG_1.CR3", to: "/Album", mode: .move, collision: .fail, transport: t)
      XCTFail("an occupied destination sidecar must collide under .fail")
    } catch FileOperationError.destinationExists {}

    let after = await t.allFiles()
    XCTAssertEqual(after, before)
  }

  func testReplaceRefusesASidecarOwnedByADestinationSibling() async throws {
    let t = FakeSMBTransport()
    await seedDestinationSibling(t)
    await t.seed("old", at: "/Album/IMG_1.CR3")
    let before = await t.allFiles()

    do {
      _ = try await SMBFileOperations.relocate(
        "/Source/IMG_1.CR3", to: "/Album", mode: .move, collision: .replace, transport: t)
      XCTFail("replace must not overwrite a sidecar a destination sibling still uses")
    } catch FileOperationError.destinationExists {}

    let after = await t.allFiles()
    XCTAssertEqual(after, before)
  }

  func testReplaceKeepsASiblingOwnedSidecarWhenIncomingHasNone() async throws {
    let t = FakeSMBTransport()
    await t.seed("new", at: "/Source/IMG_1.CR3")
    await t.seed("old", at: "/Album/IMG_1.CR3")
    await t.seed("jpg", at: "/Album/IMG_1.JPG")
    await t.seed("<sibling/>", at: "/Album/IMG_1.xmp")

    let outcome = try await SMBFileOperations.relocate(
      "/Source/IMG_1.CR3", to: "/Album", mode: .move, collision: .replace, transport: t)

    XCTAssertFalse(outcome.sidecarFollowed)
    let files = await t.allFiles()
    XCTAssertEqual(
      files,
      ["/Album/IMG_1.CR3": "new", "/Album/IMG_1.JPG": "jpg", "/Album/IMG_1.xmp": "<sibling/>"])
  }

  func testOrphanDestinationSidecarForcesAutoSuffixWithoutOwnSidecar() async throws {
    let t = FakeSMBTransport()
    await t.seed("new", at: "/Source/IMG_1.CR3")
    await t.seed("<orphan/>", at: "/Album/IMG_1.xmp")

    let outcome = try await SMBFileOperations.relocate(
      "/Source/IMG_1.CR3", to: "/Album", mode: .move, collision: .autoSuffix, transport: t)

    XCTAssertTrue(outcome.renamedDueToCollision)
    let files = await t.allFiles()
    XCTAssertEqual(files, ["/Album/IMG_1.1.CR3": "new", "/Album/IMG_1.xmp": "<orphan/>"])
  }
  // MARK: - Trash lifecycle of a shared sidecar

  private func trashBothHalves(_ t: FakeSMBTransport) async throws {
    await t.seed("raw", at: "/Shoot/IMG_1.CR3")
    await t.seed("jpg", at: "/Shoot/IMG_1.JPG")
    await t.seed("<shared/>", at: "/Shoot/IMG_1.xmp")
    _ = try await SMBFileOperations.trash("/Shoot/IMG_1.CR3", transport: t)
    _ = try await SMBFileOperations.trash("/Shoot/IMG_1.JPG", transport: t)
  }

  private func trashedItem(_ name: String, _ t: FakeSMBTransport) async throws -> TrashedItem {
    let items = await SMBFileOperations.listMapleTrash(transport: t)
    return try XCTUnwrap(items.first { ($0.primaryPath as NSString).lastPathComponent == name })
  }

  func testPermanentlyDeletingOneTrashedHalfKeepsTheSidecarTheOtherStillUses() async throws {
    let t = FakeSMBTransport()
    try await trashBothHalves(t)

    try await SMBFileOperations.permanentlyDeleteFromMapleTrash(
      try await trashedItem("IMG_1.CR3", t), transport: t)

    let afterFirst = await t.fileContents(at: "/.maple/trash/Shoot/IMG_1.xmp")
    XCTAssertEqual(afterFirst, "<shared/>")
    let jpg = await t.fileContents(at: "/.maple/trash/Shoot/IMG_1.JPG")
    XCTAssertEqual(jpg, "jpg")

    try await SMBFileOperations.permanentlyDeleteFromMapleTrash(
      try await trashedItem("IMG_1.JPG", t), transport: t)

    let afterSecond = await t.fileExists(at: "/.maple/trash/Shoot/IMG_1.xmp")
    XCTAssertFalse(afterSecond)
  }

  func testRestoringBothTrashedHalvesRejoinsTheSharedSidecar() async throws {
    let t = FakeSMBTransport()
    try await trashBothHalves(t)

    _ = try await SMBFileOperations.restoreFromMapleTrash(
      "/.maple/trash/Shoot/IMG_1.CR3", transport: t)
    let second = try await SMBFileOperations.restoreFromMapleTrash(
      "/.maple/trash/Shoot/IMG_1.JPG", transport: t)

    XCTAssertFalse(second.renamedDueToCollision)
    XCTAssertEqual(second.sidecarPath, "/Shoot/IMG_1.xmp")
    let files = await t.allFiles()
    XCTAssertEqual(
      files,
      ["/Shoot/IMG_1.CR3": "raw", "/Shoot/IMG_1.JPG": "jpg", "/Shoot/IMG_1.xmp": "<shared/>"])
  }
}
