import XCTest

@testable import MapleCore

/// #6134 review: a conflict copy saved by a sync tool between staging and finalize stays at the
/// source; the destination keeps the bytes it was planned with.
final class LocalConflictCopyFinalizeTests: XCTestCase {
  private var root: URL!
  private let mac = "photo (conflict from Mac).xmp"

  override func setUp() {
    super.setUp()
    root = FileOperationsTestSupport.makeTempDir()
  }

  override func tearDown() {
    FileOperationsTestSupport.cleanup(root)
    root = nil
    super.tearDown()
  }

  private func stagedMove(into folder: URL) async throws -> (plan: RelocatePlan, copy: URL) {
    let source = FileOperationsTestSupport.write(
      "pixels", to: root.appendingPathComponent("Source/photo.dng"))
    let copy = FileOperationsTestSupport.write(
      "<planned/>", to: root.appendingPathComponent("Source/\(mac)"))
    let plan = try await LocalFileOperations.planRelocate(source, to: folder, mode: .move)
    return (plan, copy)
  }

  func testAMoveKeepsAConflictCopyThatChangedAfterPlanning() async throws {
    let album = root.appendingPathComponent("Album")
    let staged = try await stagedMove(into: album)
    FileOperationsTestSupport.write("<saved later/>", to: staged.copy)

    await LocalFileOperations.finalizeRelocate(staged.plan)

    XCTAssertEqual(FileOperationsTestSupport.contents(staged.copy), "<saved later/>")
    XCTAssertEqual(
      FileOperationsTestSupport.contents(album.appendingPathComponent(mac)), "<planned/>")
    XCTAssertFalse(
      FileOperationsTestSupport.exists(root.appendingPathComponent("Source/photo.dng")))
  }

  func testATrashKeepsAConflictCopyThatChangedAfterPlanning() async throws {
    let trashFolder = try LocalFileOperations.trashDestinationDir(
      for: root.appendingPathComponent("Source/photo.dng"), libraryRoot: root)
    let staged = try await stagedMove(into: trashFolder)
    FileOperationsTestSupport.write("<saved later/>", to: staged.copy)

    await LocalFileOperations.finalizeRelocate(staged.plan)

    XCTAssertEqual(FileOperationsTestSupport.contents(staged.copy), "<saved later/>")
    XCTAssertEqual(
      FileOperationsTestSupport.contents(trashFolder.appendingPathComponent(mac)), "<planned/>")
  }

  func testAnUnchangedConflictCopyIsStillRemovedFromTheSource() async throws {
    let album = root.appendingPathComponent("Album")
    let staged = try await stagedMove(into: album)

    await LocalFileOperations.finalizeRelocate(staged.plan)

    XCTAssertFalse(FileOperationsTestSupport.exists(staged.copy))
    XCTAssertEqual(
      FileOperationsTestSupport.contents(album.appendingPathComponent(mac)), "<planned/>")
  }
}
