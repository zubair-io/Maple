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
    } catch FileOperationError.destinationExists(let path) {
      XCTAssertEqual(path, destination.appendingPathComponent("IMG_1.JPG").path, "names the JPEG")
    }

    XCTAssertEqual(names(in: source), ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp"])
    XCTAssertEqual(names(in: destination), ["IMG_1.JPG"])
    XCTAssertEqual(
      FileOperationsTestSupport.contents(destination.appendingPathComponent("IMG_1.JPG")),
      "other-jpeg")
  }

  // MARK: - One tile, two file operations (#5050 review)

  /// Replace answered on the RAW's prompt must never overwrite an unrelated JPEG the prompt did
  /// not name.
  func testReplaceOnTheRawNeverReplacesAnUnrelatedJpeg() async throws {
    FileOperationsTestSupport.write("old-raw", to: destination.appendingPathComponent("IMG_1.CR3"))
    FileOperationsTestSupport.write(
      "other-jpeg", to: destination.appendingPathComponent("IMG_1.JPG"))

    do {
      _ = try await LocalFileOperations.relocate(
        raw, to: destination, companion: jpeg, mode: .move, collision: .replace)
      XCTFail("the JPEG was never asked about")
    } catch FileOperationError.destinationExists(let path) {
      XCTAssertEqual(path, destination.appendingPathComponent("IMG_1.JPG").path)
    }

    XCTAssertEqual(contents("IMG_1.JPG", in: destination), "other-jpeg")
    XCTAssertEqual(contents("IMG_1.CR3", in: destination), "old-raw")
    XCTAssertEqual(names(in: source), ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp"])
  }

  func testReplaceOnTheRawWithTheJpegNameFreeReplacesOnlyTheRaw() async throws {
    FileOperationsTestSupport.write("old-raw", to: destination.appendingPathComponent("IMG_1.CR3"))

    _ = try await LocalFileOperations.relocate(
      raw, to: destination, companion: jpeg, mode: .move, collision: .replace)

    XCTAssertEqual(names(in: destination), ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp"])
    XCTAssertEqual(contents("IMG_1.CR3", in: destination), "raw-bytes")
    XCTAssertEqual(contents("IMG_1.JPG", in: destination), "jpeg-bytes")
    XCTAssertEqual(names(in: source), [])
  }

  func testTheJpegIsReplacedOnlyWhenItsOwnPromptSaidSo() async throws {
    FileOperationsTestSupport.write("old-raw", to: destination.appendingPathComponent("IMG_1.CR3"))
    FileOperationsTestSupport.write(
      "other-jpeg", to: destination.appendingPathComponent("IMG_1.JPG"))

    _ = try await LocalFileOperations.relocate(
      raw, to: destination, companion: jpeg, mode: .move, collision: .replace,
      companionCollision: .replace)

    XCTAssertEqual(names(in: destination), ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp"])
    XCTAssertEqual(contents("IMG_1.JPG", in: destination), "jpeg-bytes")
    XCTAssertEqual(contents("IMG_1.xmp", in: destination), "<xmp>edits</xmp>")
  }

  /// Keep Both with only the JPEG's name taken used to fail: the free name was chosen for the RAW
  /// alone, which was free.
  func testKeepBothWithOnlyTheJpegNameTakenMovesBothToOneFreeStem() async throws {
    FileOperationsTestSupport.write(
      "other-jpeg", to: destination.appendingPathComponent("IMG_1.JPG"))

    let outcome = try await LocalFileOperations.relocate(
      raw, to: destination, companion: jpeg, mode: .move, collision: .autoSuffix)

    XCTAssertEqual(
      names(in: destination), ["IMG_1.1.CR3", "IMG_1.1.JPG", "IMG_1.1.xmp", "IMG_1.JPG"])
    XCTAssertEqual(contents("IMG_1.JPG", in: destination), "other-jpeg")
    XCTAssertEqual(contents("IMG_1.1.JPG", in: destination), "jpeg-bytes")
    XCTAssertEqual(outcome.companionPath, destination.appendingPathComponent("IMG_1.1.JPG").path)
    XCTAssertTrue(outcome.renamedDueToCollision)
    XCTAssertEqual(names(in: source), [])
  }

  func testKeepBothSkipsAStemWhoseSidecarAloneIsTaken() async throws {
    FileOperationsTestSupport.write("<other/>", to: destination.appendingPathComponent("IMG_1.xmp"))
    FileOperationsTestSupport.write(
      "other-jpeg", to: destination.appendingPathComponent("IMG_1.1.JPG"))

    _ = try await LocalFileOperations.relocate(
      raw, to: destination, companion: jpeg, mode: .move, collision: .autoSuffix)

    XCTAssertEqual(
      names(in: destination),
      ["IMG_1.1.JPG", "IMG_1.2.CR3", "IMG_1.2.JPG", "IMG_1.2.xmp", "IMG_1.xmp"])
    XCTAssertEqual(contents("IMG_1.xmp", in: destination), "<other/>")
  }

  /// iOS trashes into `.maple/trash` with Keep Both; a trash that already held the JPEG's name
  /// threw `destinationExists` for every such stack.
  func testTrashToTheMapleFolderWhenTheTrashAlreadyHoldsThatJpegName() async throws {
    let trash = source.appendingPathComponent(".maple/trash", isDirectory: true)
    FileOperationsTestSupport.write(
      "old-trashed-jpeg", to: trash.appendingPathComponent("IMG_1.JPG"))

    let outcome = try await LocalFileOperations.trashToMapleFolder(
      raw, libraryRoot: source, companion: jpeg)

    let trashed = names(in: trash).filter { !$0.contains(".trashed-") }
    XCTAssertEqual(trashed, ["IMG_1.1.CR3", "IMG_1.1.JPG", "IMG_1.1.xmp", "IMG_1.JPG"])
    XCTAssertEqual(contents("IMG_1.JPG", in: trash), "old-trashed-jpeg")
    XCTAssertEqual(outcome.companionPath, trash.appendingPathComponent("IMG_1.1.JPG").path)
    XCTAssertEqual(names(in: source), [])
  }

  /// A stack Replace whose JPEG then fails must put back the RAW and sidecar it displaced.
  func testAFailedStackReplaceRestoresTheDisplacedRawAndSidecar() async throws {
    FileOperationsTestSupport.write("old-raw", to: destination.appendingPathComponent("IMG_1.CR3"))
    FileOperationsTestSupport.write("<old/>", to: destination.appendingPathComponent("IMG_1.xmp"))
    try FileManager.default.createDirectory(
      at: destination.appendingPathComponent("IMG_1.JPG", isDirectory: true),
      withIntermediateDirectories: true)

    do {
      _ = try await LocalFileOperations.relocate(
        raw, to: destination, companion: jpeg, mode: .move, collision: .replace,
        companionCollision: .replace)
      XCTFail("a folder cannot be replaced by the JPEG")
    } catch {}

    XCTAssertEqual(contents("IMG_1.CR3", in: destination), "old-raw")
    XCTAssertEqual(contents("IMG_1.xmp", in: destination), "<old/>")
    XCTAssertEqual(names(in: destination), ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp"])
    XCTAssertEqual(names(in: source), ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp"])
    XCTAssertEqual(contents("IMG_1.CR3", in: source), "raw-bytes")
  }

  private func contents(_ name: String, in directory: URL) -> String? {
    FileOperationsTestSupport.contents(directory.appendingPathComponent(name))
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
