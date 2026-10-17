// SidecarStemRuleTests.swift — which names claim a sidecar stem (#4707):
// staging copies never do, a real `*.tmp.*` photo does, and stems compare
// case-sensitively on a case-sensitive volume. The case-sensitive scenarios
// run on a throwaway case-sensitive APFS sparse image.

import XCTest

@testable import MapleCore

final class SidecarStemRuleTests: XCTestCase {
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

  func testOnlyAnEngineStagingSuffixIsSkipped() {
    XCTAssertTrue(SidecarOwnership.isStagingName("IMG.JPG.tmp.4242-1A2B3C4D"))
    XCTAssertTrue(SidecarOwnership.isStagingName("IMG.JPG.tmp.4242-1a2b3c4d"))
    XCTAssertTrue(SidecarOwnership.isStagingName("IMG.xmp.tmp.4242.0123456789abcdef"))
    XCTAssertFalse(SidecarOwnership.isStagingName("IMG.tmp.JPG"))
    XCTAssertFalse(SidecarOwnership.isStagingName("IMG.tmp.CR3"))
    XCTAssertTrue(
      SidecarOwnership.stemClaimedBySibling(
        primaryPath: "/d/IMG.tmp.CR3", siblingNames: ["IMG.tmp.CR3", "IMG.tmp.JPG"]))
  }

  func testMovingATmpNamedRawBesideItsJpegKeepsTheSharedSidecar() async throws {
    let source = root.appendingPathComponent("Source")
    let raw = FileOperationsTestSupport.write("raw", to: source.appendingPathComponent("IMG.tmp.CR3"))
    FileOperationsTestSupport.write("jpg", to: source.appendingPathComponent("IMG.tmp.JPG"))
    FileOperationsTestSupport.write("<shared/>", to: source.appendingPathComponent("IMG.tmp.xmp"))

    _ = try await LocalFileOperations.relocate(
      raw, to: root.appendingPathComponent("Album"), mode: .move, collision: .fail)

    XCTAssertEqual(
      FileOperationsTestSupport.contents(source.appendingPathComponent("IMG.tmp.xmp")), "<shared/>")
    XCTAssertEqual(
      FileOperationsTestSupport.contents(root.appendingPathComponent("Album/IMG.tmp.xmp")),
      "<shared/>")
  }

  func testStemsCompareCaseSensitivelyWhenTheVolumeDoesNotFoldCase() {
    XCTAssertTrue(
      SidecarOwnership.stemClaimedBySibling(primaryPath: "/d/IMG.CR3", siblingNames: ["img.JPG"]))
    XCTAssertFalse(
      SidecarOwnership.stemClaimedBySibling(
        primaryPath: "/d/IMG.CR3", siblingNames: ["img.JPG"], foldsCase: false))
    XCTAssertTrue(
      SidecarOwnership.stemClaimedBySibling(
        primaryPath: "/d/IMG.CR3", siblingNames: ["IMG.JPG"], foldsCase: false))
  }

  func testAnUnknownVolumeCountsAsFoldingCase() {
    XCTAssertTrue(SidecarOwnership.localVolumeFoldsCase(root.appendingPathComponent("missing")))
  }

  // MARK: - On a case-sensitive volume

  func testTheProbeReportsACaseSensitiveVolume() throws {
    let volume = try mountCaseSensitiveVolume()
    XCTAssertFalse(SidecarOwnership.localVolumeFoldsCase(volume))
  }

  func testMovingFromACaseSensitiveFolderTakesTheSidecarACaseDifferentPhotoDoesNotRead()
    async throws
  {
    let volume = try mountCaseSensitiveVolume()
    let source = volume.appendingPathComponent("Source")
    let raw = FileOperationsTestSupport.write("raw", to: source.appendingPathComponent("IMG.CR3"))
    FileOperationsTestSupport.write("jpg", to: source.appendingPathComponent("img.JPG"))
    FileOperationsTestSupport.write("<raw/>", to: source.appendingPathComponent("IMG.xmp"))

    _ = try await LocalFileOperations.relocate(
      raw, to: volume.appendingPathComponent("Album"), mode: .move, collision: .fail)

    let fm = FileManager.default
    XCTAssertFalse(fm.fileExists(atPath: source.appendingPathComponent("IMG.xmp").path))
    XCTAssertTrue(fm.fileExists(atPath: source.appendingPathComponent("img.JPG").path))
    XCTAssertEqual(
      FileOperationsTestSupport.contents(volume.appendingPathComponent("Album/IMG.xmp")), "<raw/>")
  }

  func testReplaceClearsAStaleSidecarACaseDifferentPhotoDoesNotRead() async throws {
    let volume = try mountCaseSensitiveVolume()
    let album = volume.appendingPathComponent("Album")
    let incoming = FileOperationsTestSupport.write(
      "new", to: volume.appendingPathComponent("Source/IMG.CR3"))
    FileOperationsTestSupport.write("old", to: album.appendingPathComponent("IMG.CR3"))
    FileOperationsTestSupport.write("<stale/>", to: album.appendingPathComponent("IMG.xmp"))
    FileOperationsTestSupport.write("jpg", to: album.appendingPathComponent("img.JPG"))

    _ = try await LocalFileOperations.relocate(
      incoming, to: album, mode: .move, collision: .replace)

    let fm = FileManager.default
    XCTAssertEqual(FileOperationsTestSupport.contents(album.appendingPathComponent("IMG.CR3")), "new")
    XCTAssertFalse(fm.fileExists(atPath: album.appendingPathComponent("IMG.xmp").path))
    XCTAssertEqual(FileOperationsTestSupport.contents(album.appendingPathComponent("img.JPG")), "jpg")
  }

  /// Attaches a fresh case-sensitive APFS sparse image under `root`, detached
  /// again on teardown. Skips where `hdiutil` cannot create or attach one.
  private func mountCaseSensitiveVolume() throws -> URL {
    let image = root.appendingPathComponent("cs.sparseimage")
    let mountPoint = root.appendingPathComponent("cs-volume")
    try FileManager.default.createDirectory(at: mountPoint, withIntermediateDirectories: true)
    guard
      hdiutil([
        "create", "-size", "64m", "-fs", "Case-sensitive APFS", "-type", "SPARSE",
        "-volname", "MapleCS", image.path,
      ]),
      hdiutil(["attach", "-nobrowse", "-mountpoint", mountPoint.path, image.path])
    else { throw XCTSkip("hdiutil could not create or attach a case-sensitive volume") }
    addTeardownBlock { _ = self.hdiutil(["detach", mountPoint.path, "-force"]) }
    return mountPoint
  }

  private func hdiutil(_ arguments: [String]) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return false }
    process.waitUntilExit()
    return process.terminationStatus == 0
  }
}
