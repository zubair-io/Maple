import XCTest

@testable import MapleCore

/// #6134 on a share: conflict copies travel with their photo on move, rename and trash, under the
/// same rules as the canonical sidecar.
final class SMBConflictCopyTests: XCTestCase {
  private let mac = "photo (conflict from Mac).xmp"

  private func shelf(_ extra: [String: String] = [:]) async -> FakeSMBTransport {
    let transport = FakeSMBTransport()
    await transport.seed("pixels", at: "/src/photo.CR3")
    await transport.seed("<canonical/>", at: "/src/photo.xmp")
    await transport.seed("<mac/>", at: "/src/\(mac)")
    for (path, contents) in extra { await transport.seed(contents, at: path) }
    return transport
  }

  func testMoveCarriesTheConflictCopy() async throws {
    let transport = await shelf()

    _ = try await SMBFileOperations.relocate(
      "/src/photo.CR3", to: "/dest", mode: .move, transport: transport)

    let files = await transport.allFiles()
    XCTAssertEqual(files["/dest/\(mac)"], "<mac/>")
    XCTAssertNil(files["/src/\(mac)"])
    XCTAssertEqual(files["/dest/photo.xmp"], "<canonical/>")
  }

  func testRenameCarriesTheConflictCopyUnderTheNewStem() async throws {
    let transport = await shelf()

    _ = try await SMBFileOperations.relocate(
      "/src/photo.CR3", to: "/src", newBasename: "renamed.CR3", mode: .move, collision: .fail,
      transport: transport)

    let files = await transport.allFiles()
    XCTAssertEqual(files["/src/renamed (conflict from Mac).xmp"], "<mac/>")
    XCTAssertNil(files["/src/\(mac)"])
  }

  func testTrashCarriesTheConflictCopyIntoTheTrashFolder() async throws {
    let transport = await shelf()

    _ = try await SMBFileOperations.trash("/src/photo.CR3", transport: transport)

    let files = await transport.allFiles()
    let trashed = await transport.fileContents(at: "/.maple/trash/src/\(mac)")
    XCTAssertNil(files["/src/\(mac)"])
    XCTAssertEqual(trashed, "<mac/>")
  }

  func testRestoreBringsTheTrashedConflictCopyBack() async throws {
    let transport = await shelf()
    let trashed = try await SMBFileOperations.trash("/src/photo.CR3", transport: transport)

    _ = try await SMBFileOperations.restoreFromMapleTrash(trashed.primaryPath, transport: transport)

    let files = await transport.allFiles()
    XCTAssertEqual(files["/src/\(mac)"], "<mac/>")
  }

  func testPurgeRemovesTheTrashedConflictCopy() async throws {
    let transport = await shelf()
    _ = try await SMBFileOperations.trash("/src/photo.CR3", transport: transport)
    let items = await SMBFileOperations.listMapleTrash(transport: transport)
    let item = try XCTUnwrap(items.first)
    let heldBefore = await transport.fileExists(at: "/.maple/trash/src/\(mac)")

    try await SMBFileOperations.permanentlyDeleteFromMapleTrash(item, transport: transport)

    let heldAfter = await transport.fileExists(at: "/.maple/trash/src/\(mac)")
    XCTAssertTrue(heldBefore)
    XCTAssertFalse(heldAfter)
  }

  func testAConflictCopyBesideItsPhotoInTrashIsNotSweptAsAnOrphan() async {
    XCTAssertFalse(
      SidecarOwnership.isOrphanedSidecar(mac, siblingNames: ["photo.CR3", "photo.xmp"]))
    XCTAssertTrue(SidecarOwnership.isOrphanedSidecar(mac, siblingNames: ["other.CR3"]))
  }

  func testMovingOneHalfOfAPairCopiesTheConflictCopyAndLeavesItForTheOther() async throws {
    let transport = await shelf(["/src/photo.JPG": "jpeg"])

    _ = try await SMBFileOperations.relocate(
      "/src/photo.CR3", to: "/dest", mode: .move, transport: transport)

    let files = await transport.allFiles()
    XCTAssertEqual(files["/src/\(mac)"], "<mac/>")
    XCTAssertEqual(files["/dest/\(mac)"], "<mac/>")
  }

  func testTheLastHalfOfAPairTakesTheConflictCopyAndJoinsTheIdenticalOne() async throws {
    let transport = await shelf(["/src/photo.JPG": "jpeg"])

    _ = try await SMBFileOperations.relocate(
      "/src/photo.CR3", to: "/dest", mode: .move, transport: transport)
    let outcome = try await SMBFileOperations.relocate(
      "/src/photo.JPG", to: "/dest", mode: .move, transport: transport)

    XCTAssertEqual((outcome.primaryPath as NSString).lastPathComponent, "photo.JPG")
    let files = await transport.allFiles()
    XCTAssertNil(files["/src/\(mac)"])
    XCTAssertEqual(files["/dest/\(mac)"], "<mac/>")
  }

  func testAnotherPhotosOwnSidecarIsNotCarried() async throws {
    let transport = await shelf(["/src/photo (conflict from Mac).CR3": "other pixels"])

    _ = try await SMBFileOperations.relocate(
      "/src/photo.CR3", to: "/dest", mode: .move, transport: transport)

    let files = await transport.allFiles()
    XCTAssertEqual(files["/src/\(mac)"], "<mac/>")
    XCTAssertNil(files["/dest/\(mac)"])
  }

  func testAnUnrelatedConflictCopyAtTheDestinationCollidesTheWholePhoto() async throws {
    let transport = await shelf(["/dest/\(mac)": "<theirs/>"])

    do {
      _ = try await SMBFileOperations.relocate(
        "/src/photo.CR3", to: "/dest", mode: .move, collision: .fail, transport: transport)
      XCTFail("an occupied conflict copy name must collide")
    } catch FileOperationError.destinationExists {
    }

    let files = await transport.allFiles()
    XCTAssertEqual(files["/src/photo.CR3"], "pixels")
    XCTAssertEqual(files["/src/\(mac)"], "<mac/>")
    XCTAssertEqual(files["/dest/\(mac)"], "<theirs/>")
    XCTAssertNil(files["/dest/photo.CR3"])
  }

  func testAutoSuffixSkipsAStemWhoseConflictCopyNameIsTaken() async throws {
    let transport = await shelf(["/dest/\(mac)": "<theirs/>"])

    let outcome = try await SMBFileOperations.relocate(
      "/src/photo.CR3", to: "/dest", mode: .move, collision: .autoSuffix, transport: transport)

    XCTAssertEqual((outcome.primaryPath as NSString).lastPathComponent, "photo.1.CR3")
    let files = await transport.allFiles()
    XCTAssertEqual(files["/dest/\(mac)"], "<theirs/>")
    XCTAssertEqual(files["/dest/photo.1 (conflict from Mac).xmp"], "<mac/>")
  }

  func testAFailedConflictCopyCopyLeavesEverythingAsItWas() async throws {
    let transport = FakeSMBTransport()
    await transport.seed("pixels", at: "/src/photo.CR3")
    await transport.seed("<mac/>", at: "/src/\(mac)")
    await transport.setFailCopyToPath("/dest/\(mac)")

    do {
      _ = try await SMBFileOperations.relocate(
        "/src/photo.CR3", to: "/dest", mode: .move, transport: transport)
      XCTFail("a conflict copy that cannot be copied must stop the move")
    } catch {
    }

    let files = await transport.allFiles()
    XCTAssertEqual(
      files,
      ["/src/photo.CR3": "pixels", "/src/\(mac)": "<mac/>"])
  }

  func testAConflictCopyChangedAfterPlanningStaysAtTheSource() async throws {
    let transport = await shelf()
    let plan = try await SMBFileOperations.planRelocate(
      "/src/photo.CR3", to: "/dest", mode: .move, transport: transport)
    await transport.seed("<saved later/>", at: "/src/\(mac)")

    _ = await SMBFileOperations.finalizeRelocate(plan, transport: transport)

    let files = await transport.allFiles()
    XCTAssertEqual(files["/src/\(mac)"], "<saved later/>")
    XCTAssertEqual(files["/dest/\(mac)"], "<mac/>")
  }
}
