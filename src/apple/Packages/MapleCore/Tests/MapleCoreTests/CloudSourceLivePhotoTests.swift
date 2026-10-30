import Foundation
import XCTest

@testable import MapleCore

final class CloudSourceLivePhotoTests: XCTestCase {
  private func listing(images: String) throws -> FsDirListing {
    let json = """
      {"path":"/srv/photos/Library/Trip","parentPath":"/srv/photos/Library","folders":[],
       "images":[\(images)]}
      """
    return try JSONDecoder().decode(FsDirListing.self, from: Data(json.utf8))
  }

  private func entry(name: String, extra: String = "") -> String {
    """
    {"name":"\(name)","path":"/srv/photos/Library/Trip/\(name)","mtime":"2026-01-01T00:00:00Z",
     "size":10,"ext":"\((name as NSString).pathExtension)"\(extra)}
    """
  }

  func testListingDecodesBothHalvesOfAPair() throws {
    let decoded = try listing(
      images: [
        entry(name: "IMG_1.HEIC", extra: #","livePhoto":{"role":"still","partner":"IMG_1.MOV"}"#),
        entry(name: "IMG_1.MOV", extra: #","livePhoto":{"role":"clip","partner":"IMG_1.HEIC"}"#),
      ].joined(separator: ","))

    XCTAssertEqual(
      decoded.images.map(\.livePhoto),
      [
        LivePhotoLink(role: .still, partner: "IMG_1.MOV"),
        LivePhotoLink(role: .clip, partner: "IMG_1.HEIC"),
      ])
  }

  func testListingLeavesAnUnpairedImageWithoutALink() throws {
    let decoded = try listing(images: entry(name: "IMG_2.HEIC"))

    XCTAssertNil(decoded.images.first?.livePhoto)
  }

  func testPartnerIDKeepsTheFolderAndSwapsTheFilename() {
    let link = LivePhotoLink(role: .still, partner: "IMG 1.MOV")

    XCTAssertEqual(
      link.partnerRefID(ofRefID: "fs:/srv/photos/Library/My Album/IMG 1.HEIC"),
      "fs:/srv/photos/Library/My Album/IMG 1.MOV")
  }

  func testPartnerClipURLIsMintedWithoutAnyRequest() async throws {
    let fixture = try await CloudOriginalHTTPFixture.start()
    defer { fixture.stop() }
    let client = AuthenticatedHTTPClient(
      server: fixture.url, urlSession: URLSession(configuration: .ephemeral),
      tokensProvider: { AuthTokens(access: "original-token", refresh: "refresh-token") },
      onTokensRefreshed: { _ in }, onSignOut: {})
    let source = CloudSource(
      server: fixture.url, folderID: "", libraryPath: "", httpClient: client)
    let link = LivePhotoLink(role: .still, partner: "IMG_1.MOV")

    let url = try await source.videoURL(
      for: link.partnerRefID(ofRefID: "fs:/srv/photos/Library/Trip/IMG_1.HEIC"))

    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    XCTAssertEqual(components?.path, "/maple/api/video/fs")
    XCTAssertEqual(
      components?.queryItems?.first { $0.name == "path" }?.value,
      "/srv/photos/Library/Trip/IMG_1.MOV")
    XCTAssertEqual(
      components?.queryItems?.first { $0.name == "token" }?.value, "original-token")
    XCTAssertTrue(fixture.requests.isEmpty)
  }

  func testOverlaysCarryTheLiveRoleAndEqualityNoticesIt() {
    let still = GridCellOverlays(livePhoto: .still)

    XCTAssertEqual(still.livePhoto, .still)
    XCTAssertNotEqual(still, GridCellOverlays())
  }
}
