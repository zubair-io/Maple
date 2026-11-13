import Foundation
import XCTest

@testable import MapleCore

/// #5544: an SMB share pairs its Live Photos by content identifier, read through range reads
/// against an owned Samba server.
@MainActor
final class LivePhotoSMBTests: XCTestCase {
  private typealias Fixtures = LivePhotoFixtures
  private let first = "3F2A8C1E-9B47-4D55-A6E0-0C7D1B2E4F90"
  private let second = "9A1B2C3D-0000-4D55-A6E0-0C7D1B2E4F91"

  private func open() async throws -> OwnedSMBWorkflowFixture {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let trip = fixture.share.appendingPathComponent("Trip", isDirectory: true)
    let other = fixture.share.appendingPathComponent("Other", isDirectory: true)
    for directory in [trip, other] {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    try Fixtures.still("heic", contentID: first).write(
      to: trip.appendingPathComponent("IMG_1.HEIC"))
    try Data(Fixtures.clip(contentID: first)).write(to: trip.appendingPathComponent("IMG_1.MOV"))
    // A renamed stem, a mismatched identifier and an orphan clip.
    try Fixtures.still("jpg", contentID: first).write(to: trip.appendingPathComponent("IMG_E2.JPG"))
    try Data(Fixtures.clip(contentID: first)).write(to: trip.appendingPathComponent("IMG_2.MOV"))
    try Fixtures.still("heic", contentID: first).write(
      to: trip.appendingPathComponent("IMG_3.HEIC"))
    try Data(Fixtures.clip(contentID: second)).write(to: trip.appendingPathComponent("IMG_3.MOV"))
    try Data(Fixtures.clip(contentID: second)).write(to: trip.appendingPathComponent("IMG_4.MOV"))
    // The same stem and identifier in another folder never pairs across folders.
    try Data(Fixtures.clip(contentID: first)).write(to: other.appendingPathComponent("IMG_1.MOV"))
    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: fixture.credentials)
    return fixture
  }

  func testPairsOnlyAStillAndClipThatAgreeOnFolderStemAndIdentifier() async throws {
    let fixture = try await open()

    let links = await fixture.source.livePhotoLinks()

    XCTAssertEqual(
      links,
      [
        "/Trip/IMG_1.HEIC": LivePhotoLink(role: .still, partner: "IMG_1.MOV"),
        "/Trip/IMG_1.MOV": LivePhotoLink(role: .clip, partner: "IMG_1.HEIC"),
      ])
  }

  func testBrowsingTheShareCarriesTheLinksOnTheAssets() async throws {
    let fixture = try await open()
    let browse = BrowseViewModel()

    await browse.loadSource(fixture.source)

    let linked = browse.assets.filter { $0.livePhoto != nil }.compactMap(\.smbPath).sorted()
    XCTAssertEqual(linked, ["/Trip/IMG_1.HEIC", "/Trip/IMG_1.MOV"])
    let other = browse.assets.first { $0.smbPath == "/Other/IMG_1.MOV" }
    XCTAssertNil(other?.livePhoto)
  }

  func testTheClipPlaysFromAStagedCopyForBothHalves() async throws {
    let fixture = try await open()
    let browse = BrowseViewModel()
    await browse.loadSource(fixture.source)
    let still = try XCTUnwrap(browse.assets.first { $0.smbPath == "/Trip/IMG_1.HEIC" })
    let clip = try XCTUnwrap(browse.assets.first { $0.smbPath == "/Trip/IMG_1.MOV" })

    let fromStill = await LivePhotoClip.playbackURL(for: still, source: fixture.source)
    let fromClip = await LivePhotoClip.playbackURL(for: clip, source: fixture.source)

    let expected = Data(Fixtures.clip(contentID: first))
    XCTAssertEqual(try Data(contentsOf: try XCTUnwrap(fromStill)), expected)
    XCTAssertEqual(try Data(contentsOf: try XCTUnwrap(fromClip)), expected)
    for url in [fromStill, fromClip].compactMap({ $0 }) {
      try? FileManager.default.removeItem(at: url)
    }
  }

  func testAClipFromAnotherShareIsRefused() async throws {
    let fixture = try await open()

    do {
      _ = try await fixture.source.liveClipFile(atPath: "/Trip/IMG_1.MOV", listedBy: UUID())
      XCTFail("a path listed by another share was read")
    } catch SMBError.foreignShare(let name) {
      XCTAssertEqual(name, "IMG_1.MOV")
    }
  }
}
