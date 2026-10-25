import Foundation
import MapleCloudKit
import XCTest

@testable import MapleWatch

@MainActor
final class WatchPhotoPageTests: XCTestCase {
  func testEmptyFilteredMemoryPageStillOffersNextUntilServerTotalExhausted() async {
    let model = makeModel(host: "paged.test")
    await model.load(page: 0)
    XCTAssertNil(model.error)
    XCTAssertTrue(model.assets.isEmpty)
    XCTAssertTrue(model.hasMore)
    await model.load(page: 1)
    XCTAssertEqual(model.page, 1)
    XCTAssertTrue(model.hasMore)
    await model.load(page: 2)
    XCTAssertEqual(model.page, 2)
    XCTAssertFalse(model.hasMore)
  }

  func testTrulyEmptyCollectionHasNoNextPage() async {
    let model = makeModel(host: "empty.test")
    await model.load(page: 0)
    XCTAssertNil(model.error)
    XCTAssertTrue(model.assets.isEmpty)
    XCTAssertFalse(model.hasMore)
  }

  private func makeModel(host: String) -> WatchPhotoPage {
    let server = URL(string: "https://\(host)")!
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [WatchMemoryProtocol.self]
    let payload = Data(#"{"exp":4102444800}"#.utf8).base64EncodedString()
    let http = AuthenticatedHTTPClient(
      server: server, urlSession: URLSession(configuration: config),
      tokensProvider: {
        AuthTokens(access: "header.\(payload).signature", refresh: "test-refresh")
      },
      onTokensRefreshed: { _ in XCTFail("Unexpected refresh") },
      onSignOut: { XCTFail("Unexpected sign-out") })
    return WatchPhotoPage(
      search: CloudSearchClient(server: server, httpClient: http),
      memories: GeneratedSearchClient(server: server, httpClient: http),
      source: .memory("memory-one"))
  }
}

private final class WatchMemoryProtocol: URLProtocol {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let url = request.url,
      url.path == "/api/generated-searches/memory-one/assets",
      let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
      query.contains(URLQueryItem(name: "limit", value: "20")),
      let offset = query.first(where: { $0.name == "offset" })?.value,
      ["0", "20", "40"].contains(offset)
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    let total = url.host == "empty.test" ? 0 : 45
    let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data("{\"results\":[],\"total\":\(total)}".utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
