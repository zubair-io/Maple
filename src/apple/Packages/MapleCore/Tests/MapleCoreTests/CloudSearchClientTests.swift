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

  func test_search_buildsURLAndParsesResponse() async throws {
    let server = URL(string: "https://example.test")!
    let json = """
    {"total":1,"page":0,"limit":100,"results":[
      {"id":"fs:/p/a.dng","folder_id":"lib-1","abs_path":"/p/a.dng","filename":"a.dng",
       "rating":5,"flag":1,"color_label":"red"}
    ]}
    """
    // Capture the outgoing request URL so we can assert the query contract.
    let captured = CapturedURL()
    let session = URLSession.stubbedSequence { req in
      captured.value = req.url
      let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let client = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    var params = SearchParams(libraryID: "lib-1")
    params.q = "beach"
    params.rating = 4
    params.flag = .pick
    let result = try await client.search(params, page: 0, limit: 100)

    XCTAssertEqual(result.total, 1)
    XCTAssertEqual(result.results.first?.color_label, "red")

    let comps = URLComponents(url: captured.value!, resolvingAgainstBaseURL: false)!
    XCTAssertEqual(comps.path, "/api/search")
    let items = Dictionary(uniqueKeysWithValues:
      (comps.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    XCTAssertEqual(items["q"], "beach")
    XCTAssertEqual(items["libraryId"], "lib-1")
    XCTAssertEqual(items["rating"], "4")
    XCTAssertEqual(items["flag"], "pick")
    XCTAssertEqual(items["page"], "0")
    XCTAssertEqual(items["limit"], "100")
    XCTAssertEqual(items["sort"], "captured_desc")
  }

  func test_facets_parsesResponse() async throws {
    let server = URL(string: "https://example.test")!
    let json = """
    {"total":7,
     "cameras":[{"make":"Canon","model":"R5","count":4}],
     "lenses":[{"value":"RF 50","count":3},{"value":null,"count":1}],
     "extensions":[{"value":"dng","count":7}],
     "iso_range":{"min":100,"max":6400},
     "capture_range":{"from":"2024-01-01T00:00:00Z","to":"2024-12-31T23:59:59Z"},
     "scene_types":[{"value":"outdoor","count":5}],
     "activities":[{"value":"hiking","count":2}],
     "subjects":[{"value":"mountain","count":3}],
     "is_screenshot":{"true":1,"false":5,"unknown":1}}
    """
    let session = URLSession.stubbed(response: json)
    let client = CloudSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let facets = try await client.facets(SearchParams(libraryID: "lib-1"))

    XCTAssertEqual(facets.total, 7)
    XCTAssertEqual(facets.cameras.first?.model, "R5")
    XCTAssertEqual(facets.lenses.count, 2)
    XCTAssertNil(facets.lenses[1].value)
    XCTAssertEqual(facets.iso_range?.max, 6400)
    XCTAssertEqual(facets.scene_types.first?.value, "outdoor")
    XCTAssertEqual(facets.is_screenshot.trueCount, 1)
    XCTAssertEqual(facets.is_screenshot.falseCount, 5)
    XCTAssertEqual(facets.is_screenshot.unknown, 1)
  }

  // MARK: - relativePathPrefix

  func test_relativePathPrefix_subfolderIsRelativeToRoot() {
    XCTAssertEqual(
      CloudSearchClient.relativePathPrefix(absPath: "/srv/Lib/2026/spain", libraryRoot: "/srv/Lib"),
      "2026/spain")
  }

  func test_relativePathPrefix_libraryRootSelectedReturnsNil() {
    // Root selected → no sub-folder narrowing (libraryId scopes it).
    XCTAssertNil(
      CloudSearchClient.relativePathPrefix(absPath: "/srv/Lib", libraryRoot: "/srv/Lib"))
  }

  func test_relativePathPrefix_tolerantOfTrailingSlashes() {
    XCTAssertEqual(
      CloudSearchClient.relativePathPrefix(absPath: "/srv/Lib/2026/", libraryRoot: "/srv/Lib/"),
      "2026")
    XCTAssertNil(
      CloudSearchClient.relativePathPrefix(absPath: "/srv/Lib/", libraryRoot: "/srv/Lib"))
  }

  func test_relativePathPrefix_siblingPrefixDoesNotMatch() {
    // `/srv/Lib` must not swallow `/srv/Lib2026` — the boundary slash guards it.
    XCTAssertNil(
      CloudSearchClient.relativePathPrefix(absPath: "/srv/Lib2026", libraryRoot: "/srv/Lib"))
  }

  func test_relativePathPrefix_nilOrForeignRootReturnsNil() {
    XCTAssertNil(
      CloudSearchClient.relativePathPrefix(absPath: "/srv/Lib/2026", libraryRoot: nil))
    XCTAssertNil(
      CloudSearchClient.relativePathPrefix(absPath: "/other/2026", libraryRoot: "/srv/Lib"))
  }

  func test_relativePathPrefix_filesystemRootLibrary() {
    XCTAssertEqual(
      CloudSearchClient.relativePathPrefix(absPath: "/Lib", libraryRoot: "/"),
      "Lib")
    XCTAssertNil(
      CloudSearchClient.relativePathPrefix(absPath: "/", libraryRoot: "/"))
  }
}

/// Box for capturing the request URL out of the stub closure.
private final class CapturedURL: @unchecked Sendable {
  var value: URL?
}
