// CloudSearchClientTests.swift
import XCTest
@testable import MapleCore

final class CloudSearchClientTests: XCTestCase {

  func test_buckets_parsesResponse() async throws {
    let server = URL(string: "https://example.test")!
    let json = """
    {"total":12,"buckets":[{"year":2024,"month":7,"count":7},{"year":2024,"month":6,"count":5}],"untimed_count":0}
    """
    let session = URLSession.stubbed(response: json)
    let client = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let result = try await client.buckets(libraryID: "lib-1")

    XCTAssertEqual(result.total, 12)
    XCTAssertEqual(result.buckets.count, 2)
    XCTAssertEqual(result.buckets[0].year, 2024)
    XCTAssertEqual(result.buckets[0].month, 7)
    XCTAssertEqual(result.buckets[0].count, 7)
  }

  func test_page_parsesResponse() async throws {
    let server = URL(string: "https://example.test")!
    let json = """
    {"total":42,"page":1,"limit":200,"results":[
      {"id":"a1","folder_id":"lib-1","abs_path":"/photos/a1.dng","filename":"a1.dng",
       "size":1024,"mtime":1719792000000,"captured_at":"2024-07-15T12:00:00Z",
       "camera":{"make":"Canon","model":"R5"},"lens":null,"iso":100,"aperture":5.6,
       "shutter":"1/200","focal_length":50.0,"rating":4,"flag":null,"color_label":null}
    ]}
    """
    let session = URLSession.stubbed(response: json)
    let client = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let result = try await client.page(libraryID: "lib-1", year: 2024, month: 7)

    XCTAssertEqual(result.total, 42)
    XCTAssertEqual(result.results.count, 1)
    XCTAssertEqual(result.results[0].id, "a1")
    XCTAssertEqual(result.results[0].rating, 4)
    XCTAssertEqual(result.results[0].camera?.model, "R5")
  }
}
