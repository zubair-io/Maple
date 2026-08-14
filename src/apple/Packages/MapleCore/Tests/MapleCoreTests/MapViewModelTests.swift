// MapViewModelTests.swift
//
// Covers MapViewModel's region-change debounce and its generation-counter
// stale-response guard (docs/best-practices.md §"Generation counters for
// async state") — #2830. `fetch(region:)` is package-internal so these
// tests can drive it directly, bypassing the debounce, to make the
// stale-response race deterministic.

import XCTest
@testable import MapleCore
@testable import MapleCloudKit

@MainActor
final class MapViewModelTests: XCTestCase {

  private func region(lat: Double = 0, lng: Double = 0) -> MapViewportRegion {
    MapViewportRegion(centerLatitude: lat, centerLongitude: lng,
                      latitudeDelta: 1, longitudeDelta: 1)
  }

  // MARK: - fetch(region:)

  func test_fetch_success_populatesCellsAndClearsIsEmpty() async throws {
    let server = URL(string: "https://example.test")!
    let json = """
    {"cells":[{"lat":1,"lng":2,"count":1,"representativeAssetId":"a","thumbKey":"/a.jpg"}]}
    """
    let session = URLSession.stubbed(response: json)
    let client = MapClustersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let vm = MapViewModel(server: server, client: client)

    await vm.fetch(region: region())

    XCTAssertEqual(vm.cells.map(\.representativeAssetId), ["a"])
    XCTAssertFalse(vm.isEmpty)
    XCTAssertNil(vm.loadError)
  }

  func test_fetch_emptyCells_setsIsEmptyTrue() async throws {
    let server = URL(string: "https://example.test")!
    let session = URLSession.stubbed(response: #"{"cells":[]}"#)
    let client = MapClustersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let vm = MapViewModel(server: server, client: client)

    await vm.fetch(region: region())

    XCTAssertTrue(vm.cells.isEmpty)
    XCTAssertTrue(vm.isEmpty)
  }

  /// A fetch failure must keep the last good cells rendered — a tile/data
  /// outage should not blank the map (design doc, "Cluster fetch
  /// failure"). One client whose FIRST request succeeds and SECOND fails,
  /// driven against one VM so the second fetch's failure is checked
  /// against real prior state, not a freshly-constructed VM.
  func test_fetch_failure_keepsPreviousCellsAndSetsLoadError() async throws {
    let server = URL(string: "https://example.test")!
    let goodJSON = """
    {"cells":[{"lat":1,"lng":2,"count":1,"representativeAssetId":"a","thumbKey":"/a.jpg"}]}
    """
    nonisolated(unsafe) var requestCount = 0
    let session = URLSession.stubbedSequence { req in
      requestCount += 1
      if requestCount == 1 {
        let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": "application/json"])!
        return (Data(goodJSON.utf8), resp)
      }
      let resp = HTTPURLResponse(url: req.url!, statusCode: 500, httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": "text/plain"])!
      return (Data("server error".utf8), resp)
    }
    let client = MapClustersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let vm = MapViewModel(server: server, client: client)

    await vm.fetch(region: region())
    XCTAssertEqual(vm.cells.count, 1)
    XCTAssertNil(vm.loadError)

    await vm.fetch(region: region(lat: 5))
    XCTAssertEqual(vm.cells.count, 1, "a fetch failure must not clear previously-fetched cells")
    XCTAssertNotNil(vm.loadError)
    XCTAssertFalse(vm.isEmpty, "a failure is not the same as a confirmed-empty result")
  }

  // MARK: - heatmapPoints (#2831)

  /// The heatmap's weights are derived once per fetch and published
  /// alongside `cells`, so the draw path never has to normalize (an O(n)
  /// max + allocation) on a per-frame basis. Weights are relative to the
  /// hottest cell in the response: count 25 → 1.0, count 5 → 0.2.
  func test_fetch_derivesHeatmapPointsFromCells() async throws {
    let server = URL(string: "https://example.test")!
    let json = """
    {"cells":[{"lat":1,"lng":2,"count":5,"representativeAssetId":"a"},
              {"lat":3,"lng":4,"count":25,"representativeAssetId":"b"}]}
    """
    let session = URLSession.stubbed(response: json)
    let client = MapClustersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let vm = MapViewModel(server: server, client: client)

    await vm.fetch(region: region())

    XCTAssertEqual(vm.heatmapPoints.count, 2)
    XCTAssertEqual(vm.heatmapPoints.map(\.weight), [0.2, 1.0])
    XCTAssertEqual(vm.heatmapPoints.map(\.latitude), [1, 3])
  }

  /// A confirmed-empty region must publish no heat at all — otherwise the
  /// heatmap would keep painting the previous region's blobs over an empty
  /// map.
  func test_fetch_emptyCells_clearsHeatmapPoints() async throws {
    let server = URL(string: "https://example.test")!
    nonisolated(unsafe) var requestCount = 0
    let session = URLSession.stubbedSequence { req in
      requestCount += 1
      let json = requestCount == 1
        ? #"{"cells":[{"lat":1,"lng":2,"count":3,"representativeAssetId":"a"}]}"#
        : #"{"cells":[]}"#
      let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let client = MapClustersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let vm = MapViewModel(server: server, client: client)

    await vm.fetch(region: region())
    XCTAssertEqual(vm.heatmapPoints.count, 1)

    await vm.fetch(region: region(lat: 5))
    XCTAssertTrue(vm.heatmapPoints.isEmpty, "an empty region must publish no heat")
  }

  /// `heatmapPoints` must stay in lockstep with `cells` — including on the
  /// failure path, where `cells` is deliberately NOT cleared so the map
  /// keeps showing the last good data. The heatmap must keep showing the
  /// same thing the pins do rather than blanking on its own.
  func test_fetch_failure_keepsHeatmapPointsInLockstepWithCells() async throws {
    let server = URL(string: "https://example.test")!
    nonisolated(unsafe) var requestCount = 0
    let session = URLSession.stubbedSequence { req in
      requestCount += 1
      if requestCount == 1 {
        let json = #"{"cells":[{"lat":1,"lng":2,"count":4,"representativeAssetId":"a"}]}"#
        let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": "application/json"])!
        return (Data(json.utf8), resp)
      }
      let resp = HTTPURLResponse(url: req.url!, statusCode: 500, httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": "text/plain"])!
      return (Data("server error".utf8), resp)
    }
    let client = MapClustersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let vm = MapViewModel(server: server, client: client)

    await vm.fetch(region: region())
    await vm.fetch(region: region(lat: 5))

    XCTAssertEqual(vm.cells.count, 1)
    XCTAssertEqual(vm.heatmapPoints.count, vm.cells.count,
      "heatmapPoints must track cells exactly, including across a failed fetch")
  }

  /// The `preview(cells:)` factory routes through the same derivation, so a
  /// SwiftUI preview shows heat rather than a bare map.
  func test_preview_derivesHeatmapPoints() {
    let vm = MapViewModel.preview(cells: [
      MapCluster(lat: 10, lng: 20, count: 2, representativeAssetId: "a"),
      MapCluster(lat: 11, lng: 21, count: 8, representativeAssetId: "b"),
    ])
    XCTAssertEqual(vm.heatmapPoints.map(\.weight), [0.25, 1.0])
  }

  /// Stale-completion guard. A slow response for an earlier region must
  /// not clobber the cells a later region's (faster) fetch already wrote.
  func test_fetch_dropsStaleResponse_afterNewerFetchBumpsGeneration() async throws {
    let server = URL(string: "https://example.test")!
    // Distinguish the two in-flight requests by their `bbox` query value
    // (regionA vs regionB produce different bboxes) rather than by
    // arrival order — the delay below is what controls arrival order.
    let session = URLSession.stubbedSequence(delay: .milliseconds(80)) { req in
      let query = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
      let bbox = query.first(where: { $0.name == "bbox" })?.value ?? ""
      // regionA (center lng 0) produces a negative `west`; regionB
      // (center lng 20) produces a positive one — distinguish on that
      // sign rather than on arrival order.
      let assetID = bbox.hasPrefix("-") ? "region-a-cell" : "region-b-cell"
      let json = #"{"cells":[{"lat":0,"lng":0,"count":1,"representativeAssetId":"\#(assetID)","thumbKey":"/x.jpg"}]}"#
      let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                 headerFields: ["Content-Type": "application/json"])!
      return (Data(json.utf8), resp)
    }
    let client = MapClustersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let vm = MapViewModel(server: server, client: client)

    let regionA = region(lat: 0, lng: 0)   // bbox west == -0.5 (negative)
    let regionB = region(lat: 20, lng: 20) // bbox west == 19.5 (positive)

    // regionA's fetch starts first (slow: 80ms from t=0 → lands ~t=80ms).
    async let slow: Void = vm.fetch(region: regionA)
    // regionB's fetch starts second, after regionA already bumped
    // generation to 1 — this call bumps it to 2 before its own 80ms delay
    // (lands ~t=100ms, i.e. AFTER regionA's stale response).
    try await Task.sleep(for: .milliseconds(20))
    await vm.fetch(region: regionB)
    _ = await slow

    // Only regionB's (later-generation) response should have landed.
    XCTAssertEqual(vm.cells.map(\.representativeAssetId), ["region-b-cell"],
      "a stale response from a superseded region must not overwrite newer cells")
  }

  // MARK: - regionChanged(_:) debounce

  func test_regionChanged_debouncesRapidCalls() async throws {
    let server = URL(string: "https://example.test")!
    let json = #"{"cells":[]}"#

    actor Counter {
      private(set) var starts = 0
      func increment() { starts += 1 }
    }
    let counter = Counter()
    let session = URLSession.stubbed(response: json, onRequestStart: { await counter.increment() })
    let client = MapClustersClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session))
    let vm = MapViewModel(server: server, client: client, debounceDelay: .milliseconds(30))

    vm.regionChanged(region(lat: 0))
    vm.regionChanged(region(lat: 1))
    vm.regionChanged(region(lat: 2))

    try await Task.sleep(for: .milliseconds(150))

    let starts = await counter.starts
    XCTAssertEqual(starts, 1,
      "only the last regionChanged call within the debounce window should fire a request")
  }
}
