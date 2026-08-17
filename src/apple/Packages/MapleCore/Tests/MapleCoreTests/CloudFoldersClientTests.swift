// CloudFoldersClientTests.swift
import XCTest
@testable import MapleCore

final class CloudFoldersClientTests: XCTestCase {
  func test_listFolders_returnsParsedDTOs() async throws {
    let server = URL(string: "https://example.test")!
    let json = """
    [
      {"id":"f1","path":"/photos/2024","label":"2024",
       "last_scan":null,"file_count":42,"created_at":"2026-01-01T00:00:00Z"},
      {"id":"f2","path":"/photos/2023","label":"",
       "last_scan":"2026-04-01T00:00:00Z","file_count":7,"created_at":"2025-12-01T00:00:00Z"}
    ]
    """
    let session = URLSession.stubbed(response: json)
    let client = CloudFoldersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let folders = try await client.listFolders()

    XCTAssertEqual(folders.count, 2)
    XCTAssertEqual(folders[0].id, "f1")
    XCTAssertEqual(folders[0].displayName, "2024")
    XCTAssertEqual(folders[1].displayName, "2023")
    // Pre-#2898 payload carries no `connected` key — treated as connected,
    // so pre-upgrade servers never hide anything.
    XCTAssertNil(folders[0].connected)
    XCTAssertTrue(folders[0].isConnected)
  }

  func test_listFolders_decodesConnectivity() async throws {
    let server = URL(string: "https://example.test")!
    let json = """
    [
      {"id":"f1","path":"/photos/2024","label":"2024",
       "last_scan":null,"file_count":42,"created_at":"2026-01-01T00:00:00Z",
       "connected":true},
      {"id":"f2","path":"/mnt/nas-archive","label":"NAS",
       "last_scan":null,"file_count":9000,"created_at":"2025-12-01T00:00:00Z",
       "connected":false}
    ]
    """
    let session = URLSession.stubbed(response: json)
    let client = CloudFoldersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let folders = try await client.listFolders()

    XCTAssertTrue(folders[0].isConnected)
    XCTAssertFalse(folders[1].isConnected)
  }

  func test_listFolders_freshBypassesConnectivityCache() async throws {
    let server = URL(string: "https://example.test")!
    // Capture each request URL so the assertion is about what actually
    // went on the wire, not about client internals.
    final class Box: @unchecked Sendable { var urls: [URL] = [] }
    let box = Box()
    let session = URLSession.stubbedSequence { req in
      box.urls.append(req.url!)
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data("[]".utf8), resp)
    }
    let client = CloudFoldersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    _ = try await client.listFolders()
    _ = try await client.listFolders(fresh: true)

    XCTAssertEqual(box.urls.count, 2)
    XCTAssertNil(box.urls[0].query, "default fetch must NOT send fresh")
    XCTAssertEqual(box.urls[1].query, "fresh=1")
  }
}
