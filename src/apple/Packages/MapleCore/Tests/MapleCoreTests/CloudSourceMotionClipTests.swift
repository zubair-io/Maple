import Foundation
import XCTest

@testable import MapleCore

final class CloudSourceMotionClipTests: XCTestCase {
  private func source(_ fixture: CloudOriginalHTTPFixture) -> CloudSource {
    let client = AuthenticatedHTTPClient(
      server: fixture.url, urlSession: URLSession(configuration: .ephemeral),
      tokensProvider: { AuthTokens(access: "original-token", refresh: "refresh-token") },
      onTokensRefreshed: { _ in }, onSignOut: {})
    return CloudSource(server: fixture.url, folderID: "", libraryPath: "", httpClient: client)
  }

  func testMotionPhotoResolvesToATokenizedAddressURLAfterAHeadProbe() async throws {
    let fixture = try await CloudOriginalHTTPFixture.start()
    defer { fixture.stop() }

    let url = try await source(fixture).motionClipURL(
      for: "fs:/srv/photos/Library/My Album/PXL_1.MP.jpg")

    XCTAssertEqual(
      url?.absoluteString,
      "\(fixture.url.absoluteString)api/motion/library/My%20Album/PXL_1.MP.jpg?token=original-token"
    )
    XCTAssertTrue(
      fixture.requests.contains {
        $0.hasPrefix("HEAD /maple/api/motion/library/My%20Album/PXL_1.MP.jpg?token=")
      })
    XCTAssertFalse(fixture.requests.contains { $0.hasPrefix("GET /maple/api/motion/") })
  }

  func testPlainStillHasNoMotionClip() async throws {
    let fixture = try await CloudOriginalHTTPFixture.start()
    defer { fixture.stop() }

    let url = try await source(fixture).motionClipURL(
      for: "fs:/srv/photos/Library/My Album/plain.jpg")

    XCTAssertNil(url)
  }
}
