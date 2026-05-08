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
  }
}
