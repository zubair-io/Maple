import Foundation
import ImageIO
import MapleCloudKit
import UniformTypeIdentifiers
import XCTest

@testable import MapleWatch

final class WatchImageStoreTests: XCTestCase {
  func testRepeatLoadIsServedFromMemory() async throws {
    let (store, host) = makeStore(thumbStatus: 200)
    _ = try await store.image(for: try asset(), tier: .row)
    _ = try await store.image(for: try asset(), tier: .row)
    XCTAssertEqual(StubDerivatives.requests(host: host), ["thumb"])
  }

  func testFailedThumbnailFallsBackToPreview() async throws {
    let (store, host) = makeStore(thumbStatus: 404)
    let image = try await store.image(for: try asset(), tier: .photo)
    XCTAssertGreaterThan(image.width, 0)
    XCTAssertEqual(StubDerivatives.requests(host: host), ["thumb", "preview"])
  }

  func testRefreshForcesAFreshDownload() async throws {
    let (store, host) = makeStore(thumbStatus: 200)
    _ = try await store.image(for: try asset(), tier: .row)
    await store.clear()
    _ = try await store.image(for: try asset(), tier: .row)
    XCTAssertEqual(StubDerivatives.requests(host: host), ["thumb", "thumb"])
  }

  func testDisconnectedStoreRefusesLoads() async throws {
    let (store, host) = makeStore(thumbStatus: 200)
    await store.invalidate()
    do {
      _ = try await store.image(for: try asset(), tier: .row)
      XCTFail("an invalidated store returned an image")
    } catch is CancellationError {}
    XCTAssertEqual(StubDerivatives.requests(host: host), [])
  }

  private func makeStore(thumbStatus: Int) -> (WatchImageStore, String) {
    let host = "\(UUID().uuidString.lowercased()).watch-images.test"
    StubDerivatives.configure(host: host, thumbStatus: thumbStatus)
    let server = URL(string: "https://\(host)")!
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubDerivatives.self]
    let payload = Data(#"{"exp":4102444800}"#.utf8).base64EncodedString()
    let http = AuthenticatedHTTPClient(
      server: server, urlSession: URLSession(configuration: config),
      tokensProvider: {
        AuthTokens(access: "header.\(payload).signature", refresh: "test-refresh")
      },
      onTokensRefreshed: { _ in XCTFail("Unexpected refresh") },
      onSignOut: { XCTFail("Unexpected sign-out") })
    let store = WatchImageStore(
      server: server, client: CloudThumbClient(server: server, httpClient: http))
    return (store, host)
  }

  private func asset() throws -> SearchAsset {
    try JSONDecoder().decode(
      SearchAsset.self,
      from: Data(
        #"{"id":"a1","folder_id":"f1","abs_path":"/srv/photos/a.dng","filename":"a.dng","mtime":1}"#
          .utf8))
  }
}

/// A server with one library at /srv/photos whose derivative routes return a
/// small PNG, except a thumbnail status chosen per host. Records each
/// derivative request per host.
private final class StubDerivatives: URLProtocol {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var thumbStatus: [String: Int] = [:]
  nonisolated(unsafe) private static var log: [String: [String]] = [:]

  static func configure(host: String, thumbStatus status: Int) {
    lock.withLock {
      thumbStatus[host] = status
      log[host] = []
    }
  }

  static func requests(host: String) -> [String] {
    lock.withLock { log[host] ?? [] }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let host = url.host else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    if url.path == "/api/folders" {
      respond(
        url: url, status: 200,
        body: Data(
          #"[{"id":"f1","slug":"photos","path":"/srv/photos","label":"Photos","last_scan":null,"file_count":1,"created_at":"2026-01-01T00:00:00Z"}]"#
            .utf8))
      return
    }
    let route = url.pathComponents.dropFirst(2).first ?? ""
    let status = Self.lock.withLock {
      Self.log[host, default: []].append(route)
      return route == "thumb" ? Self.thumbStatus[host] ?? 200 : 200
    }
    respond(url: url, status: status, body: status == 200 ? Self.png : Data())
  }

  override func stopLoading() {}

  private func respond(url: URL, status: Int, body: Data) {
    let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: body)
    client?.urlProtocolDidFinishLoading(self)
  }

  private static let png: Data = {
    let context = CGContext(
      data: nil, width: 4, height: 4, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(red: 0.2, green: 0.5, blue: 0.8, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
    let data = NSMutableData()
    let destination = CGImageDestinationCreateWithData(
      data, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    CGImageDestinationFinalize(destination)
    return data as Data
  }()
}
