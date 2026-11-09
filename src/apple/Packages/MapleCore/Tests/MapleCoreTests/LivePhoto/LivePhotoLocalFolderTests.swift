import Foundation
import XCTest

@testable import MapleCore

/// #5544: a local folder pairs its Live Photos by content identifier, read from real files.
@MainActor
final class LivePhotoLocalFolderTests: XCTestCase {
  private typealias Fixtures = LivePhotoFixtures
  private let first = "3F2A8C1E-9B47-4D55-A6E0-0C7D1B2E4F90"
  private let second = "9A1B2C3D-0000-4D55-A6E0-0C7D1B2E4F91"
  private var folder: URL!

  override func setUpWithError() throws {
    folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("live-folder-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: folder)
  }

  private func write(_ name: String, still contentID: String?) throws {
    try Fixtures.still((name as NSString).pathExtension, contentID: contentID)
      .write(to: folder.appendingPathComponent(name))
  }

  private func write(_ name: String, clip contentID: String?) throws {
    try Data(Fixtures.clip(contentID: contentID)).write(to: folder.appendingPathComponent(name))
  }

  private func listed() async -> [String: LivePhotoLink] {
    let browse = BrowseViewModel()
    await browse.loadFolder(url: folder)
    return Dictionary(
      uniqueKeysWithValues: browse.assets.compactMap { asset in
        asset.livePhoto.map { (asset.primaryURL?.lastPathComponent ?? "", $0) }
      })
  }

  func testPairsAStillAndClipWhoseIdentifiersMatch() async throws {
    try write("IMG_1.HEIC", still: first)
    try write("IMG_1.MOV", clip: first)
    try write("IMG_2.JPG", still: second)
    try write("IMG_2.MOV", clip: second)

    let links = await listed()

    XCTAssertEqual(
      links,
      [
        "IMG_1.HEIC": LivePhotoLink(role: .still, partner: "IMG_1.MOV"),
        "IMG_1.MOV": LivePhotoLink(role: .clip, partner: "IMG_1.HEIC"),
        "IMG_2.JPG": LivePhotoLink(role: .still, partner: "IMG_2.MOV"),
        "IMG_2.MOV": LivePhotoLink(role: .clip, partner: "IMG_2.JPG"),
      ])
  }

  func testAMatchingIdentifierUnderARenamedStemStaysTwoFiles() async throws {
    try write("IMG_E1234.HEIC", still: first)
    try write("IMG_1234.MOV", clip: first)

    let links = await listed()

    XCTAssertTrue(links.isEmpty)
  }

  func testASharedStemWithDifferentIdentifiersStaysTwoFiles() async throws {
    try write("IMG_1.HEIC", still: first)
    try write("IMG_1.MOV", clip: second)

    let links = await listed()

    XCTAssertTrue(links.isEmpty)
  }

  func testNoIdentifierMeansNoPairingEvenWithASharedStem() async throws {
    try write("IMG_1.HEIC", still: nil)
    try write("IMG_1.MOV", clip: first)
    try write("IMG_2.HEIC", still: first)
    try write("IMG_2.MOV", clip: nil)

    let links = await listed()

    XCTAssertTrue(links.isEmpty)
  }

  func testAnOrphanClipStaysUnpaired() async throws {
    try write("IMG_7.MOV", clip: first)
    try write("IMG_8.HEIC", still: first)

    let links = await listed()

    XCTAssertTrue(links.isEmpty)
  }

  func testDuplicateIdentifiersOnTwoStillsLeaveTheGroupUnpaired() async throws {
    try write("IMG_1.HEIC", still: first)
    try write("IMG_1.JPG", still: first)
    try write("IMG_1.MOV", clip: first)

    let links = await listed()

    XCTAssertTrue(links.isEmpty)
  }

  func testASecondStillWithAnotherIdentifierDoesNotBreakTheMatchingPair() async throws {
    try write("IMG_1.HEIC", still: first)
    try write("IMG_1.JPG", still: second)
    try write("IMG_1.MOV", clip: first)

    let links = await listed()

    XCTAssertEqual(
      links,
      [
        "IMG_1.HEIC": LivePhotoLink(role: .still, partner: "IMG_1.MOV"),
        "IMG_1.MOV": LivePhotoLink(role: .clip, partner: "IMG_1.HEIC"),
      ])
  }

  func testTheClipAndItsStillBothPlayTheClipFile() async throws {
    try write("IMG_1.HEIC", still: first)
    try write("IMG_1.MOV", clip: first)
    let browse = BrowseViewModel()
    await browse.loadFolder(url: folder)
    let still = try XCTUnwrap(
      browse.assets.first { $0.primaryURL?.lastPathComponent == "IMG_1.HEIC" })
    let clip = try XCTUnwrap(
      browse.assets.first { $0.primaryURL?.lastPathComponent == "IMG_1.MOV" })

    let fromStill = await LivePhotoClip.playbackURL(for: still, source: nil)
    let fromClip = await LivePhotoClip.playbackURL(for: clip, source: nil)

    XCTAssertEqual(fromStill?.lastPathComponent, "IMG_1.MOV")
    XCTAssertEqual(
      fromStill?.deletingLastPathComponent().standardizedFileURL.path,
      folder.standardizedFileURL.path)
    XCTAssertEqual(fromClip, clip.primaryURL)
  }

  func testAnUnpairedAssetHasNoClip() async throws {
    try write("IMG_1.HEIC", still: first)
    let browse = BrowseViewModel()
    await browse.loadFolder(url: folder)
    let still = try XCTUnwrap(browse.assets.first)

    let url = await LivePhotoClip.playbackURL(for: still, source: nil)

    XCTAssertNil(url)
  }
}
