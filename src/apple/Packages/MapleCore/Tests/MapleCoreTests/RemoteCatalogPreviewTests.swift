import Foundation
import XCTest

@testable import MapleCore

final class RemoteCatalogPreviewTests: XCTestCase {
  private let roots = Data(
    #"[{"id":"f1","slug":"photos","path":"/photos","label":"Photos","file_count":1,"created_at":"2026-01-01T00:00:00Z"}]"#
      .utf8)

  func testPreviewUsesVersionedUnifiedAddressAndRevalidatesBytes() async throws {
    let server = URL(string: "https://example.test/maple/")!
    var requests: [URLRequest] = []
    let session = URLSession.stubbedSequence { request in
      requests.append(request)
      let isRoot = request.url!.path.hasSuffix("/api/folders")
      let cached = request.value(forHTTPHeaderField: "If-None-Match") == "preview-etag"
      let body = isRoot ? self.roots : cached ? Data() : Data("published-preview".utf8)
      return (
        body,
        HTTPURLResponse(
          url: request.url!, statusCode: cached ? 304 : 200,
          httpVersion: "HTTP/1.1", headerFields: ["ETag": "preview-etag"])!
      )
    }
    let catalog = RemoteCatalog(
      http: .unauthenticated(server: server, urlSession: session), server: server)
    let path = "/photos/My Album #?/photo %.dng"
    let first = try await catalog.getPreview(absPath: path)
    let second = try await catalog.getPreview(absPath: path)
    XCTAssertEqual(first, Data("published-preview".utf8))
    XCTAssertEqual(second, first)
    XCTAssertEqual(requests.filter { $0.url!.path.hasSuffix("/api/folders") }.count, 1)
    let previews = requests.filter { !$0.url!.path.hasSuffix("/api/folders") }
    XCTAssertEqual(previews.count, 2)
    for request in previews {
      let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
      XCTAssertEqual(
        components.percentEncodedPath,
        "/maple/api/preview/photos/My%20Album%20%23%3F/photo%20%25.dng")
      XCTAssertEqual(
        components.queryItems, [URLQueryItem(name: "pv", value: String(MaplePipelineVersion.value))]
      )
    }
    XCTAssertEqual(previews.last?.value(forHTTPHeaderField: "If-None-Match"), "preview-etag")
  }

  func testPreviewRejectsUnregisteredPathWithoutLegacyRequest() async throws {
    let server = URL(string: "https://example.test")!
    var requests: [URLRequest] = []
    let session = URLSession.stubbedSequence { request in
      requests.append(request)
      return (
        self.roots,
        HTTPURLResponse(
          url: request.url!, statusCode: 200,
          httpVersion: "HTTP/1.1", headerFields: nil)!
      )
    }
    let catalog = RemoteCatalog(
      http: .unauthenticated(server: server, urlSession: session), server: server)
    do {
      _ = try await catalog.getPreview(absPath: "/outside/photo.dng")
      XCTFail("unregistered preview must be rejected")
    } catch {
      XCTAssertEqual(error as? CloudAddressError, .unregisteredPath("/outside/photo.dng"))
    }
    XCTAssertEqual(requests.map { $0.url!.path }, ["/api/folders"])
  }
}
