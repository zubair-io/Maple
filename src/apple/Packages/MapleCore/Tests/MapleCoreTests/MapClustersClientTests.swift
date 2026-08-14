// MapClustersClientTests.swift
//
// Covers the URL composition + JSON decode path for `GET
// /api/map/clusters` (#2830). The server-side aggregation itself is a
// sibling ticket (#2825/#2832) — this client is "compose bbox/zoom/filter
// into the query string, decode the cells, surface errors."

import XCTest
@testable import MapleCloudKit

final class MapClustersClientTests: XCTestCase {

  func test_clusters_decodesCells() async throws {
    let json = """
    {"cells":[
      {"lat":48.85,"lng":2.35,"count":1,"representativeAssetId":"a1","placeLabel":"Paris","thumbKey":"/p/a.dng"},
      {"lat":35.68,"lng":139.69,"count":7,"representativeAssetId":"a2","placeLabel":"Tokyo"}
    ]}
    """
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: json, contentType: "application/json", status: 200)
    let client = MapClustersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    let bbox = MapBBox(west: -10, south: -10, east: 10, north: 10)
    let response = try await client.clusters(bbox: bbox, zoom: 5, filter: SearchParams())

    XCTAssertEqual(response.cells.count, 2)
    XCTAssertEqual(response.cells[0].representativeAssetId, "a1")
    XCTAssertEqual(response.cells[0].thumbKey, "/p/a.dng")
    XCTAssertEqual(response.cells[1].count, 7)
    XCTAssertNil(response.cells[1].thumbKey)
  }

  func test_clusters_targetsCorrectPathWithBboxZoomAndFilter() async throws {
    nonisolated(unsafe) var capturedURL: URL?
    let server = URL(string: "https://x")!
    let session = URLSession.stubbedSequence { req in
      capturedURL = req.url
      let resp = HTTPURLResponse(
        url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      return (Data(#"{"cells":[]}"#.utf8), resp)
    }
    let client = MapClustersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))

    var filter = SearchParams()
    filter.placeQuery = "harbor"
    filter.scope = "places"
    let bbox = MapBBox(west: 1, south: 2, east: 3, north: 4)
    _ = try await client.clusters(bbox: bbox, zoom: 12, filter: filter)

    let url = try XCTUnwrap(capturedURL)
    XCTAssertEqual(url.path, "/api/map/clusters")
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    let byName = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
    XCTAssertEqual(byName["bbox"], "1.0,2.0,3.0,4.0")
    XCTAssertEqual(byName["zoom"], "12")
    XCTAssertEqual(byName["placeQuery"], "harbor")
    XCTAssertEqual(byName["scope"], "places")
    // The map endpoint takes no sort/paging — facetQueryItems() must not
    // leak either onto the wire.
    XCTAssertNil(byName["sort"])
    XCTAssertNil(byName["page"])
  }

  func test_clusters_404_throws() async {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: "not found", contentType: "application/json", status: 404)
    let client = MapClustersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    do {
      _ = try await client.clusters(bbox: MapBBox(west: 0, south: 0, east: 1, north: 1),
                                    zoom: 1, filter: SearchParams())
      XCTFail("expected throw on 404")
    } catch {
      let nsErr = error as NSError
      XCTAssertEqual(nsErr.domain, "MapClustersClient")
      XCTAssertEqual(nsErr.code, 404)
    }
  }

  func test_clusters_malformedBody_throwsDecodeError() async {
    let server = URL(string: "https://x")!
    let session = URLSession.stubbed(response: "not json at all", contentType: "application/json", status: 200)
    let client = MapClustersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    do {
      _ = try await client.clusters(bbox: MapBBox(west: 0, south: 0, east: 1, north: 1),
                                    zoom: 1, filter: SearchParams())
      XCTFail("expected a decode error")
    } catch is DecodingError {
      // expected
    } catch {
      XCTFail("expected DecodingError, got \(error)")
    }
  }
}
