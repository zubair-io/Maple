import XCTest

@testable import MapleCore

final class LocalWorkflowVariantRelocateTests: XCTestCase {
  private var root: URL!
  private let firstID = "02348cbb-c0e7-4813-ab46-7c296e528a70"
  private let secondID = "12348cbb-c0e7-4813-ab46-7c296e528a70"

  override func setUp() {
    super.setUp()
    root = FileOperationsTestSupport.makeTempDir()
  }

  override func tearDown() {
    FileOperationsTestSupport.cleanup(root)
    root = nil
    super.tearDown()
  }

  func testRenameCarriesEveryUUIDBranchAndLeavesForeignVersion() async throws {
    let source = FileOperationsTestSupport.write(
      "pixels", to: root.appendingPathComponent("snapshot-test.dng"))
    let canonical = FileOperationsTestSupport.write(
      "primary edit", to: SidecarPath.sidecarURL(for: source))
    let first = FileOperationsTestSupport.write(
      "first edit", to: try SidecarPath.variantURL(for: source, variantId: firstID))
    let second = FileOperationsTestSupport.write(
      "second edit", to: try SidecarPath.variantURL(for: source, variantId: secondID))
    let foreign = FileOperationsTestSupport.write(
      "foreign", to: root.appendingPathComponent("snapshot-test.v2.xmp"))
    let target = root.appendingPathComponent("snapshot-renamed.dng")

    let outcome = try await LocalFileOperations.relocate(
      source, to: root, newBasename: target.lastPathComponent, mode: .move, collision: .fail)

    XCTAssertEqual(outcome.primaryPath, target.path)
    XCTAssertFalse(FileOperationsTestSupport.exists(source))
    XCTAssertFalse(FileOperationsTestSupport.exists(canonical))
    XCTAssertFalse(FileOperationsTestSupport.exists(first))
    XCTAssertFalse(FileOperationsTestSupport.exists(second))
    XCTAssertEqual(FileOperationsTestSupport.contents(target), "pixels")
    XCTAssertEqual(
      FileOperationsTestSupport.contents(SidecarPath.sidecarURL(for: target)), "primary edit")
    XCTAssertEqual(
      FileOperationsTestSupport.contents(
        try SidecarPath.variantURL(for: target, variantId: firstID)), "first edit")
    XCTAssertEqual(
      FileOperationsTestSupport.contents(
        try SidecarPath.variantURL(for: target, variantId: secondID)), "second edit")
    XCTAssertEqual(FileOperationsTestSupport.contents(foreign), "foreign")
  }

  func testOrphanUUIDBranchBlocksRenameWithoutTouchingSource() async throws {
    let source = FileOperationsTestSupport.write(
      "pixels", to: root.appendingPathComponent("photo.dng"))
    let variant = FileOperationsTestSupport.write(
      "source edit", to: try SidecarPath.variantURL(for: source, variantId: firstID))
    let target = root.appendingPathComponent("renamed.dng")
    let orphan = FileOperationsTestSupport.write(
      "other edit", to: try SidecarPath.variantURL(for: target, variantId: secondID))

    do {
      _ = try await LocalFileOperations.relocate(
        source, to: root, newBasename: target.lastPathComponent, mode: .move, collision: .fail)
      XCTFail("orphan branch must block the whole rename")
    } catch FileOperationError.destinationExists {
      // Expected collision.
    }
    XCTAssertEqual(FileOperationsTestSupport.contents(source), "pixels")
    XCTAssertEqual(FileOperationsTestSupport.contents(variant), "source edit")
    XCTAssertEqual(FileOperationsTestSupport.contents(orphan), "other edit")
    XCTAssertFalse(FileOperationsTestSupport.exists(target))
  }

  func testReplaceRefusesUnrelatedDestinationBranch() async throws {
    let source = FileOperationsTestSupport.write(
      "incoming", to: root.appendingPathComponent("Source/photo.dng"))
    let target = FileOperationsTestSupport.write(
      "existing", to: root.appendingPathComponent("Album/photo.dng"))
    let branch = FileOperationsTestSupport.write(
      "existing version", to: try SidecarPath.variantURL(for: target, variantId: secondID))

    do {
      _ = try await LocalFileOperations.relocate(
        source, to: target.deletingLastPathComponent(), mode: .move, collision: .replace)
      XCTFail("Replace cannot attach the existing photo's version to a different photo")
    } catch FileOperationError.destinationExists {
      // Expected collision.
    }

    XCTAssertEqual(FileOperationsTestSupport.contents(source), "incoming")
    XCTAssertEqual(FileOperationsTestSupport.contents(target), "existing")
    XCTAssertEqual(FileOperationsTestSupport.contents(branch), "existing version")
  }

  func testCopyAndRevertKeepSourceBranches() async throws {
    let source = FileOperationsTestSupport.write(
      "pixels", to: root.appendingPathComponent("photo.dng"))
    let variant = FileOperationsTestSupport.write(
      "version", to: try SidecarPath.variantURL(for: source, variantId: firstID))
    let folder = root.appendingPathComponent("Album")
    let plan = try await LocalFileOperations.planRelocate(source, to: folder, mode: .copy)
    let target = URL(fileURLWithPath: plan.finalPrimaryPath)
    let targetVariant = try SidecarPath.variantURL(for: target, variantId: firstID)
    XCTAssertEqual(FileOperationsTestSupport.contents(targetVariant), "version")
    XCTAssertEqual(FileOperationsTestSupport.contents(variant), "version")

    LocalFileOperations.revertPlan(plan)
    XCTAssertFalse(FileOperationsTestSupport.exists(target))
    XCTAssertFalse(FileOperationsTestSupport.exists(targetVariant))
    XCTAssertEqual(FileOperationsTestSupport.contents(source), "pixels")
    XCTAssertEqual(FileOperationsTestSupport.contents(variant), "version")
  }

  func testCaseOnlyRenameCarriesUUIDBranch() async throws {
    let source = FileOperationsTestSupport.write(
      "pixels", to: root.appendingPathComponent("photo.dng"))
    let variant = FileOperationsTestSupport.write(
      "version", to: try SidecarPath.variantURL(for: source, variantId: firstID))
    let target = root.appendingPathComponent("PHOTO.DNG")

    let outcome = try await LocalFileOperations.relocate(
      source, to: root, newBasename: target.lastPathComponent, mode: .move)

    XCTAssertEqual(outcome.primaryPath, target.path)
    XCTAssertEqual(FileOperationsTestSupport.contents(target), "pixels")
    XCTAssertTrue(outcome.sidecarFollowed)
    let listing = try FileManager.default.contentsOfDirectory(atPath: root.path)
    XCTAssertTrue(listing.contains("PHOTO.v\(firstID).xmp"))
    XCTAssertFalse(listing.contains(variant.lastPathComponent))
  }

  func testSharedStemKeepsSourceBranchWhenOnePhotoMoves() async throws {
    let source = FileOperationsTestSupport.write(
      "raw", to: root.appendingPathComponent("photo.dng"))
    let sibling = FileOperationsTestSupport.write(
      "jpeg", to: root.appendingPathComponent("photo.jpg"))
    let variant = FileOperationsTestSupport.write(
      "shared edit", to: try SidecarPath.variantURL(for: source, variantId: firstID))
    let target = root.appendingPathComponent("Album/photo.dng")

    _ = try await LocalFileOperations.relocate(
      source, to: target.deletingLastPathComponent(), mode: .move)

    XCTAssertEqual(FileOperationsTestSupport.contents(sibling), "jpeg")
    XCTAssertEqual(FileOperationsTestSupport.contents(variant), "shared edit")
    XCTAssertEqual(
      FileOperationsTestSupport.contents(
        try SidecarPath.variantURL(for: target, variantId: firstID)),
      "shared edit")
  }

  func testSecondHalfOfRawJpegPairJoinsIdenticalCarriedBranch() async throws {
    let raw = FileOperationsTestSupport.write(
      "raw", to: root.appendingPathComponent("photo.dng"))
    let jpeg = FileOperationsTestSupport.write(
      "jpeg", to: root.appendingPathComponent("photo.jpg"))
    let sourceVariant = FileOperationsTestSupport.write(
      "shared edit", to: try SidecarPath.variantURL(for: raw, variantId: firstID))
    let folder = root.appendingPathComponent("Album")

    _ = try await LocalFileOperations.relocate(raw, to: folder, mode: .move)
    let outcome = try await LocalFileOperations.relocate(jpeg, to: folder, mode: .move)

    XCTAssertEqual(URL(fileURLWithPath: outcome.primaryPath).lastPathComponent, "photo.jpg")
    XCTAssertFalse(FileOperationsTestSupport.exists(sourceVariant))
    XCTAssertEqual(
      FileOperationsTestSupport.contents(
        try SidecarPath.variantURL(
          for: folder.appendingPathComponent("photo.dng"), variantId: firstID)),
      "shared edit")
    XCTAssertFalse(
      FileOperationsTestSupport.exists(
        try SidecarPath.variantURL(
          for: folder.appendingPathComponent("photo.1.jpg"), variantId: firstID)))
  }

  func testAutoSuffixAvoidsOrphanBranchAtRequestedStem() async throws {
    let source = FileOperationsTestSupport.write(
      "pixels", to: root.appendingPathComponent("Source/photo.dng"))
    let variant = FileOperationsTestSupport.write(
      "version", to: try SidecarPath.variantURL(for: source, variantId: firstID))
    let folder = root.appendingPathComponent("Album")
    let orphan = FileOperationsTestSupport.write(
      "other",
      to: try SidecarPath.variantURL(
        for: folder.appendingPathComponent("photo.dng"), variantId: secondID))

    let outcome = try await LocalFileOperations.relocate(
      source, to: folder, mode: .move, collision: .autoSuffix)

    XCTAssertEqual(URL(fileURLWithPath: outcome.primaryPath).lastPathComponent, "photo.1.dng")
    XCTAssertEqual(FileOperationsTestSupport.contents(orphan), "other")
    XCTAssertFalse(FileOperationsTestSupport.exists(variant))
    XCTAssertEqual(
      FileOperationsTestSupport.contents(
        try SidecarPath.variantURL(
          for: URL(fileURLWithPath: outcome.primaryPath), variantId: firstID)), "version")
  }

  func testInvalidSourceBranchLeavesOriginalAndNoDestination() async throws {
    let source = FileOperationsTestSupport.write(
      "pixels", to: root.appendingPathComponent("photo.dng"))
    let canonical = FileOperationsTestSupport.write(
      "primary edit", to: SidecarPath.sidecarURL(for: source))
    let invalidBranch = try SidecarPath.variantURL(for: source, variantId: firstID)
    try FileManager.default.createDirectory(at: invalidBranch, withIntermediateDirectories: true)
    let target = root.appendingPathComponent("renamed.dng")

    do {
      _ = try await LocalFileOperations.relocate(
        source, to: root, newBasename: target.lastPathComponent, mode: .move)
      XCTFail("a directory cannot be carried as a workflow XMP")
    } catch {
      // The move must fail before publishing the primary or any sidecar.
    }

    XCTAssertEqual(FileOperationsTestSupport.contents(source), "pixels")
    XCTAssertEqual(FileOperationsTestSupport.contents(canonical), "primary edit")
    XCTAssertTrue(FileOperationsTestSupport.exists(invalidBranch))
    XCTAssertFalse(FileOperationsTestSupport.exists(target))
    XCTAssertFalse(FileOperationsTestSupport.exists(SidecarPath.sidecarURL(for: target)))
  }
}
