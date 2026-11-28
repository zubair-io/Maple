import XCTest

@testable import MapleCore

/// #6134 review: renaming `photo.dng` to the name of its own conflict copy must never let that
/// copy become the renamed photo's sidecar and then be removed as a carried source.
final class LocalConflictCopyAliasTests: XCTestCase {
  private var root: URL!
  private let renamed = "photo (conflict from Mac).dng"

  override func setUp() {
    super.setUp()
    root = FileOperationsTestSupport.makeTempDir()
  }

  override func tearDown() {
    FileOperationsTestSupport.cleanup(root)
    root = nil
    super.tearDown()
  }

  private func stage(copyBytes: String) -> URL {
    FileOperationsTestSupport.write("pixels", to: root.appendingPathComponent("photo.dng"))
    FileOperationsTestSupport.write("<canonical/>", to: root.appendingPathComponent("photo.xmp"))
    FileOperationsTestSupport.write(
      copyBytes, to: root.appendingPathComponent("photo (conflict from Mac).xmp"))
    return root.appendingPathComponent("photo.dng")
  }

  private func everyFileContent() -> Set<String> {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
    return Set(
      names.filter { !$0.hasPrefix(".") }.compactMap {
        FileOperationsTestSupport.contents(root.appendingPathComponent($0))
      })
  }

  func testAnIdenticalCopyIsNotJoinedAsTheRenamedPhotosSidecarUnderFail() async throws {
    let source = stage(copyBytes: "<canonical/>")
    let before = everyFileContent()

    do {
      _ = try await LocalFileOperations.relocate(
        source, to: root, newBasename: renamed, mode: .move, collision: .fail)
      XCTFail("the target sidecar name is the photo's own conflict copy")
    } catch FileOperationError.destinationExists {
    }

    XCTAssertEqual(everyFileContent(), before)
    XCTAssertTrue(FileOperationsTestSupport.exists(source))
    XCTAssertTrue(
      FileOperationsTestSupport.exists(root.appendingPathComponent("photo (conflict from Mac).xmp"))
    )
  }

  func testAnIdenticalCopyMovesTheRenamedPhotoToAFreeStemUnderAutoSuffix() async throws {
    let source = stage(copyBytes: "<canonical/>")

    let outcome = try await LocalFileOperations.relocate(
      source, to: root, newBasename: renamed, mode: .move, collision: .autoSuffix)

    let final = URL(fileURLWithPath: outcome.primaryPath)
    XCTAssertEqual(final.lastPathComponent, "photo (conflict from Mac).1.dng")
    XCTAssertEqual(
      FileOperationsTestSupport.contents(SidecarPath.sidecarURL(for: final)), "<canonical/>")
    XCTAssertEqual(FileOperationsTestSupport.contents(final), "pixels")
  }

  func testADifferingCopyCollidesAndNothingChanges() async throws {
    let source = stage(copyBytes: "<other/>")
    let before = everyFileContent()

    do {
      _ = try await LocalFileOperations.relocate(
        source, to: root, newBasename: renamed, mode: .move, collision: .fail)
      XCTFail("the target sidecar name holds different bytes")
    } catch FileOperationError.destinationExists {
    }

    XCTAssertEqual(everyFileContent(), before)
  }

  func testADifferingCopyKeepsEveryByteUnderAutoSuffix() async throws {
    let source = stage(copyBytes: "<other/>")

    let outcome = try await LocalFileOperations.relocate(
      source, to: root, newBasename: renamed, mode: .move, collision: .autoSuffix)

    let final = URL(fileURLWithPath: outcome.primaryPath)
    XCTAssertEqual(
      FileOperationsTestSupport.contents(SidecarPath.sidecarURL(for: final)), "<canonical/>")
    XCTAssertEqual(everyFileContent(), ["pixels", "<canonical/>", "<other/>"])
  }
}
