import XCTest

@testable import MapleCore

/// #5050: the JPEG follows its RAW through move, rename and trash, on real files. The pair shares
/// one `.xmp`, which the ownership rule copies until the last sibling leaves.
final class RawJpegStackFileOperationsTests: XCTestCase {
  private var root: URL!
  private var source: URL!
  private var destination: URL!
  private var raw: URL!
  private var jpeg: URL!

  override func setUpWithError() throws {
    root = FileOperationsTestSupport.makeTempDir()
    source = root.appendingPathComponent("Source", isDirectory: true)
    destination = root.appendingPathComponent("Album", isDirectory: true)
    raw = FileOperationsTestSupport.write(
      "raw-bytes", to: source.appendingPathComponent("IMG_1.CR3"))
    jpeg = FileOperationsTestSupport.write(
      "jpeg-bytes", to: source.appendingPathComponent("IMG_1.JPG"))
    FileOperationsTestSupport.write(
      "<xmp>edits</xmp>", to: source.appendingPathComponent("IMG_1.xmp"))
    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
  }

  override func tearDown() {
    FileOperationsTestSupport.cleanup(root)
  }

  private func names(in directory: URL) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])
      .filter { !$0.hasPrefix(".") }.sorted()
  }

  func testMoveCarriesTheJpegAndTheSharedSidecarAndLeavesNothingBehind() async throws {
    let outcome = try await LocalFileOperations.relocate(
      raw, to: destination, companion: jpeg, mode: .move, collision: .fail)

    XCTAssertEqual(names(in: destination), ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp"])
    XCTAssertEqual(names(in: source), [])
    XCTAssertEqual(outcome.companionPath, destination.appendingPathComponent("IMG_1.JPG").path)
    XCTAssertEqual(
      FileOperationsTestSupport.contents(destination.appendingPathComponent("IMG_1.JPG")),
      "jpeg-bytes")
    XCTAssertEqual(
      FileOperationsTestSupport.contents(destination.appendingPathComponent("IMG_1.xmp")),
      "<xmp>edits</xmp>")
  }

  func testRenameGivesBothFilesTheNewStemAndTheCompanionKeepsItsExtension() async throws {
    let outcome = try await LocalFileOperations.relocate(
      raw, to: source, newBasename: "Trip.CR3", companion: jpeg, mode: .move, collision: .fail)

    XCTAssertEqual(names(in: source), ["Trip.CR3", "Trip.JPG", "Trip.xmp"])
    XCTAssertEqual(outcome.primaryPath, source.appendingPathComponent("Trip.CR3").path)
    XCTAssertEqual(outcome.companionPath, source.appendingPathComponent("Trip.JPG").path)
  }

  func testCopyLeavesBothSourcesAndTheirSidecarInPlace() async throws {
    _ = try await LocalFileOperations.relocate(
      raw, to: destination, companion: jpeg, mode: .copy, collision: .fail)

    XCTAssertEqual(names(in: source), ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp"])
    XCTAssertEqual(names(in: destination), ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp"])
  }

  func testACollisionSuffixOnTheRawGivesTheJpegTheSameSuffixedStem() async throws {
    FileOperationsTestSupport.write(
      "other-raw", to: destination.appendingPathComponent("IMG_1.CR3"))

    let outcome = try await LocalFileOperations.relocate(
      raw, to: destination, companion: jpeg, mode: .move, collision: .autoSuffix)

    let rawStem = URL(fileURLWithPath: outcome.primaryPath).deletingPathExtension()
      .lastPathComponent
    let jpegPath = try XCTUnwrap(outcome.companionPath)
    XCTAssertNotEqual(rawStem, "IMG_1")
    XCTAssertEqual(URL(fileURLWithPath: jpegPath).lastPathComponent, "\(rawStem).JPG")
    XCTAssertEqual(FileOperationsTestSupport.contents(URL(fileURLWithPath: jpegPath)), "jpeg-bytes")
    XCTAssertEqual(names(in: source), [])
  }

  func testAJpegThatCannotFollowLeavesTheRawAndEverythingElseWhereItWas() async throws {
    FileOperationsTestSupport.write(
      "other-jpeg", to: destination.appendingPathComponent("IMG_1.JPG"))

    do {
      _ = try await LocalFileOperations.relocate(
        raw, to: destination, companion: jpeg, mode: .move, collision: .fail)
      XCTFail("the JPEG's name is taken at the destination")
    } catch FileOperationError.destinationExists {
    }

    XCTAssertEqual(names(in: source), ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp"])
    XCTAssertEqual(names(in: destination), ["IMG_1.JPG"])
    XCTAssertEqual(
      FileOperationsTestSupport.contents(destination.appendingPathComponent("IMG_1.JPG")),
      "other-jpeg")
  }

  func testACaseOnlyRenameRenamesBothFiles() async throws {
    _ = try await LocalFileOperations.relocate(
      raw, to: source, newBasename: "img_1.CR3", companion: jpeg, mode: .move, collision: .fail)

    XCTAssertEqual(names(in: source), ["img_1.CR3", "img_1.JPG", "img_1.xmp"])
  }

  func testTrashToTheMapleFolderCarriesTheJpegAndItsSidecar() async throws {
    let outcome = try await LocalFileOperations.trashToMapleFolder(
      raw, libraryRoot: source, companion: jpeg)

    let trash = source.appendingPathComponent(".maple/trash", isDirectory: true)
    let trashed = names(in: trash)
    XCTAssertEqual(
      trashed.filter { !$0.contains(".trashed-") }, ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp"])
    XCTAssertEqual(trashed.filter { $0.contains(".trashed-") }.count, 2, "one marker per photo")
    XCTAssertEqual(names(in: source), [])
    XCTAssertEqual(outcome.companionPath, trash.appendingPathComponent("IMG_1.JPG").path)
  }

  func testTheCompanionKeepsItsOwnNameWhenTheRawsStemIsUnchanged() {
    XCTAssertEqual(
      LocalFileOperations.companionBasename(
        companion: URL(fileURLWithPath: "/a/img_1.jpg"),
        primary: URL(fileURLWithPath: "/a/IMG_1.CR3"),
        relocatedPrimaryPath: "/b/IMG_1.CR3"),
      "img_1.jpg")
  }
}
