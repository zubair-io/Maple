// CloudSourceTests.swift
import XCTest
@testable import MapleCore

final class CloudSourceTests: XCTestCase {

  // MARK: images()

  func test_images_paginatesUntilUnderLimit() async throws {
    let server = URL(string: "https://example.test")!
    var pageCounter = 0
    let session = URLSession.stubbedSequence { req in
      defer { pageCounter += 1 }
      let json: String = pageCounter == 0
        ? Self.pageJSON(page: 1, total: 250, count: 200)
        : Self.pageJSON(page: 2, total: 250, count: 50)
      let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                 httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let source = CloudSource(server: server, folderID: "f1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let refs = try await source.images()

    XCTAssertEqual(refs.count, 250)
  }

  func test_images_singlePageUnderLimit_doesNotRefetch() async throws {
    let server = URL(string: "https://example.test")!
    let json = Self.pageJSON(page: 1, total: 5, count: 5)
    let session = URLSession.stubbed(response: json)
    let source = CloudSource(server: server, folderID: "f1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let refs = try await source.images()
    XCTAssertEqual(refs.count, 5)
  }

  // MARK: thumb / preview / rawBytes

  func test_thumb_returnsBytesOn200() async throws {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: "JPEGBYTES",
                                     contentType: "image/jpeg",
                                     status: 200)
    let source = CloudSource(server: server, folderID: "f1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let data = try await source.thumb(for: ImageRef(id: "a1", displayName: "x.dng"))
    XCTAssertEqual(data, Data("JPEGBYTES".utf8))
  }

  func test_thumb_returnsNilOn404() async throws {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: "not found",
                                     contentType: "text/plain",
                                     status: 404)
    let source = CloudSource(server: server, folderID: "f1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let data = try await source.thumb(for: ImageRef(id: "a1", displayName: "x.dng"))
    XCTAssertNil(data)
  }

  func test_rawBytes_returnsBytesOn200() async throws {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: "RAWBYTES",
                                     contentType: "application/octet-stream",
                                     status: 200)
    let source = CloudSource(server: server, folderID: "f1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let data = try await source.rawBytes(for: ImageRef(id: "a1", displayName: "x.dng"))
    XCTAssertEqual(data, Data("RAWBYTES".utf8))
  }

  // MARK: writeXMP

  func test_writeXMP_PUTsXmlAtAssetPath() async throws {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbedSequence { req in
      let resp = HTTPURLResponse(url: req.url!, statusCode: 204,
                                 httpVersion: "HTTP/1.1",
                                 headerFields: nil)!
      return (Data(), resp)
    }
    let source = CloudSource(server: server, folderID: "f1",
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let sidecar = Sidecar(model: .default, culling: CullingState())
    try await source.writeXMP(sidecar, for: ImageRef(id: "a1", displayName: "x.dng"))

    let body = URLProtocolStub.capturedBodies["https://x/api/assets/a1/xmp"]
    XCTAssertNotNil(body)
    let xml = String(data: body ?? Data(), encoding: .utf8) ?? ""
    XCTAssertTrue(xml.contains("xmpmeta"), "expected xmpmeta XML, got: \(xml.prefix(200))")
  }

  // MARK: helpers

  private static func pageJSON(page: Int, total: Int, count: Int) -> String {
    let assets = (0..<count).map { i in
      """
      {"id":"a\(page)-\(i)","filename":"f\(i).dng","size":1024,
       "mtime":1735689600000,"rating":null,"flag":null,
       "color_label":null,"indexed_at":null}
      """
    }.joined(separator: ",")
    return """
    {"folder_id":"f1","page":\(page),"limit":200,"total":\(total),"assets":[\(assets)]}
    """
  }
}
