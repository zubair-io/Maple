import XCTest
import Foundation
@testable import MapleCore

/// Issue #3 of PR #66 review: the default download session must be
/// `.ephemeral` (no shared URLCache, no cookies, no credential storage)
/// because RAW asset bodies are large (~150 MB for a 100 MP RAW) and
/// the OS-side File Provider cache is the canonical store.
final class RemoteCatalogDownloadSessionTests: XCTestCase {
  func testDefaultDownloadSessionIsEphemeral() {
    let http = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: TestURLSession.make(),
      tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
      onTokensRefreshed: { _ in },
      onSignOut: {}
    )
    // Construct with the default download session (no injection).
    let catalog = RemoteCatalog(http: http, server: URL(string: "https://x.test")!)
    let cfg = catalog._downloadURLSessionForTesting.configuration
    // The canonical assertion: no shared URLCache.
    XCTAssertNil(cfg.urlCache, "default download session must not use a URLCache")
    // Belt-and-suspenders: cookie + credential storage also nil.
    XCTAssertNil(cfg.httpCookieStorage, "ephemeral config must not share cookie storage")
    XCTAssertNil(cfg.urlCredentialStorage, "ephemeral config must not share credential storage")
  }

  func testInjectedDownloadSessionIsRespected() {
    // Test injection still works (the stub-based tests depend on this).
    let http = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: TestURLSession.make(),
      tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
      onTokensRefreshed: { _ in },
      onSignOut: {}
    )
    let injected = TestURLSession.make()
    let catalog = RemoteCatalog(http: http,
                                server: URL(string: "https://x.test")!,
                                downloadURLSession: injected)
    XCTAssertTrue(catalog._downloadURLSessionForTesting === injected)
  }
}
