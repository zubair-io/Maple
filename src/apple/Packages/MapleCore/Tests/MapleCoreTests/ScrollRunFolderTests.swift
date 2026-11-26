import XCTest

@testable import MapleCore

final class ScrollRunFolderTests: XCTestCase {
  private var root: URL!
  private var seed: URL!
  private let fm = FileManager.default

  override func setUpWithError() throws {
    root = fm.temporaryDirectory.appendingPathComponent("scroll-run-tests-\(UUID().uuidString)")
    seed = root.appendingPathComponent("seed")
    try fm.createDirectory(at: seed, withIntermediateDirectories: true)
    try Data("b".utf8).write(to: seed.appendingPathComponent("b.dng"))
    try Data("a".utf8).write(to: seed.appendingPathComponent("a.jpg"))
    try Data("hidden".utf8).write(to: seed.appendingPathComponent(".maple-note"))
    try fm.createDirectory(
      at: seed.appendingPathComponent("nested"), withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try fm.removeItem(at: root)
  }

  private func names(in folder: URL) throws -> [String] {
    try fm.contentsOfDirectory(atPath: folder.path).sorted()
  }

  func test_stagesCountClonesCyclingThroughTheSeedInNameOrder() throws {
    let staged = try ScrollRunFolder.stage(seed: seed, count: 5, reuse: false, root: root)
    XCTAssertFalse(staged.reused)
    XCTAssertEqual(staged.url.lastPathComponent, "maple-scroll-run-5")
    XCTAssertEqual(
      try names(in: staged.url),
      ["IMG_00000.jpg", "IMG_00001.dng", "IMG_00002.jpg", "IMG_00003.dng", "IMG_00004.jpg"])
    XCTAssertEqual(
      try Data(contentsOf: staged.url.appendingPathComponent("IMG_00001.dng")), Data("b".utf8))
  }

  func test_theSeedIsLeftAsItWas() throws {
    let before = try names(in: seed)
    _ = try ScrollRunFolder.stage(seed: seed, count: 3, reuse: false, root: root)
    XCTAssertEqual(try names(in: seed), before)
  }

  func test_aFreshRunDiscardsThePreviousFolderAndItsThumbnails() throws {
    let first = try ScrollRunFolder.stage(seed: seed, count: 3, reuse: false, root: root)
    let thumbs = first.url.appendingPathComponent(".maple/thumbs")
    try fm.createDirectory(at: thumbs, withIntermediateDirectories: true)
    let second = try ScrollRunFolder.stage(seed: seed, count: 3, reuse: false, root: root)
    XCTAssertFalse(second.reused)
    XCTAssertFalse(fm.fileExists(atPath: thumbs.path))
  }

  func test_aReusedRunKeepsTheFolderAndItsThumbnails() throws {
    let first = try ScrollRunFolder.stage(seed: seed, count: 3, reuse: false, root: root)
    let thumbs = first.url.appendingPathComponent(".maple/thumbs")
    try fm.createDirectory(at: thumbs, withIntermediateDirectories: true)
    let second = try ScrollRunFolder.stage(seed: seed, count: 3, reuse: true, root: root)
    XCTAssertTrue(second.reused)
    XCTAssertEqual(second.url, first.url)
    XCTAssertTrue(fm.fileExists(atPath: thumbs.path))
  }

  func test_reuseWithNothingStagedBuildsTheFolder() throws {
    let staged = try ScrollRunFolder.stage(seed: seed, count: 2, reuse: true, root: root)
    XCTAssertFalse(staged.reused)
    XCTAssertEqual(try names(in: staged.url).count, 2)
  }

  func test_reuseOfAnIncompleteFolderRebuildsIt() throws {
    let first = try ScrollRunFolder.stage(seed: seed, count: 3, reuse: false, root: root)
    try fm.removeItem(at: first.url.appendingPathComponent("IMG_00002.jpg"))
    let second = try ScrollRunFolder.stage(seed: seed, count: 3, reuse: true, root: root)
    XCTAssertFalse(second.reused)
    XCTAssertEqual(try names(in: second.url).count, 3)
  }

  func test_differentCountsUseDifferentFolders() throws {
    let small = try ScrollRunFolder.stage(seed: seed, count: 2, reuse: false, root: root)
    let large = try ScrollRunFolder.stage(seed: seed, count: 4, reuse: false, root: root)
    XCTAssertNotEqual(small.url, large.url)
    XCTAssertEqual(try names(in: small.url).count, 2)
  }

  func test_aSeedWithNoFilesIsRefusedBeforeAnythingIsDeleted() throws {
    let first = try ScrollRunFolder.stage(seed: seed, count: 2, reuse: false, root: root)
    let empty = root.appendingPathComponent("empty")
    try fm.createDirectory(at: empty, withIntermediateDirectories: true)
    XCTAssertThrowsError(
      try ScrollRunFolder.stage(seed: empty, count: 2, reuse: false, root: root)
    ) { XCTAssertEqual($0 as? ScrollRunFolder.StagingError, .seedHasNoFiles) }
    XCTAssertEqual(try names(in: first.url).count, 2)
  }

  func test_aCountOutsideTheRangeIsRefused() {
    for count in [0, -1, 20_001] {
      XCTAssertThrowsError(
        try ScrollRunFolder.stage(seed: seed, count: count, reuse: false, root: root)
      ) { XCTAssertEqual($0 as? ScrollRunFolder.StagingError, .countOutOfRange) }
    }
  }
}
