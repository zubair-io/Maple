// SearchViewModelFacetWindowTests.swift
//
// The facet refresh a deeper page triggers (#4514) while an earlier one for
// the same window step is still on the wire (#6000).

import XCTest

@testable import MapleCloudKit
@testable import MapleCore

@MainActor
final class SearchViewModelFacetWindowTests: XCTestCase {
  private let server = URL(string: "https://stub.test")!

  private final class Stacking: @unchecked Sendable {
    private let lock = NSLock()
    private var value = true
    var on: Bool {
      get { lock.withLock { value } }
      set { lock.withLock { value = newValue } }
    }
  }

  private func makeVM(stacking: Stacking? = nil) -> SearchViewModel {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [WindowFacetsGateURLProtocol.self]
    let http = AuthenticatedHTTPClient.unauthenticated(
      server: server, urlSession: URLSession(configuration: cfg))
    let client =
      stacking.map { stacking in
        CloudSearchClient(server: server, httpClient: http, stacksRawJpeg: { stacking.on })
      } ?? CloudSearchClient(server: server, httpClient: http)
    let vm = SearchViewModel(server: server, libraryID: "lib-test", searchClient: client, limit: 50)
    vm.params.placeQuery = "city streets"
    return vm
  }

  private func waitUntil(_ timeout: Duration, _ condition: () -> Bool) async throws -> Bool {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while !condition() {
      guard ContinuousClock.now < deadline else { return false }
      try await Task.sleep(for: .milliseconds(5))
    }
    return true
  }

  func test_pagesInOneWindowStep_joinTheFacetFetchStillOnTheWire() async throws {
    let gate = WindowFacetsGateURLProtocol.arm()
    defer { gate.open() }
    let vm = makeVM()

    await vm.submit()
    await vm.loadMore()
    let firstWindowFetchStarted = try await waitUntil(.seconds(10)) {
      gate.facetPages == ["0", "1"]
    }
    XCTAssertTrue(firstWindowFetchStarted, "precondition: page 1's facets are on the wire")

    await vm.loadMore()
    // The gate is shut, so the cache cannot fill: a page that does not join asks again.
    let askedAgain = try await waitUntil(.seconds(1)) { gate.facetPages.count > 2 }
    XCTAssertFalse(askedAgain, "pages 1 and 2 share step 400; got \(gate.facetPages)")

    gate.open()
    let landed = try await waitUntil(.seconds(10)) {
      vm.facets?.total == WindowFacetsGateURLProtocol.facetTotal(page: 1, stacked: false)
    }
    XCTAssertTrue(landed, "both pages publish the shared fetch's facets")
    XCTAssertEqual(gate.facetPages, ["0", "1"], "no request arrived after the wait either")
  }

  func test_stackingChange_doesNotJoinAFetchMadeUnderTheOldSetting() async throws {
    let gate = WindowFacetsGateURLProtocol.arm()
    defer { gate.open() }
    let stacking = Stacking()
    let vm = makeVM(stacking: stacking)

    await vm.submit()
    await vm.loadMore()
    let foldedFetchStarted = try await waitUntil(.seconds(10)) {
      gate.windowFetches == [.init(page: 1, stacked: true)]
    }
    XCTAssertTrue(foldedFetchStarted, "precondition: page 1's folded facets are on the wire")

    stacking.on = false
    await vm.refreshForStackingChange()
    await vm.loadMore()
    let askedUnfolded = try await waitUntil(.seconds(10)) {
      gate.windowFetches.contains(.init(page: 1, stacked: false))
    }
    XCTAssertTrue(askedUnfolded, "the new setting needs its own fetch; got \(gate.windowFetches)")

    gate.open()
    let landed = try await waitUntil(.seconds(10)) {
      vm.facets?.total == WindowFacetsGateURLProtocol.facetTotal(page: 1, stacked: false)
    }
    XCTAssertTrue(landed, "the panel shows the unfolded window's facets")
  }
}

/// Answers `/api/search` pages at once and holds the facets of a deeper window (page 1 and up)
/// on a background queue until the test opens the gate. `StubURLProtocol` answers on the loading
/// thread, so holding a response there would stall the page requests too.
final class WindowFacetsGateURLProtocol: URLProtocol {
  struct WindowFetch: Equatable {
    let page: Int
    let stacked: Bool
  }

  final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private let turnstile = DispatchSemaphore(value: 0)
    private var fetches: [WindowFetch] = []

    fileprivate func record(_ fetch: WindowFetch) { lock.withLock { fetches.append(fetch) } }

    var facetPages: [String] { lock.withLock { fetches.map { String($0.page) } } }
    var windowFetches: [WindowFetch] { lock.withLock { fetches.filter { $0.page > 0 } } }

    func open() { turnstile.signal() }

    fileprivate func pass() {
      turnstile.wait()
      turnstile.signal()
    }
  }

  nonisolated(unsafe) private static var gate = Gate()

  static func arm() -> Gate {
    gate = Gate()
    return gate
  }

  static func facetTotal(page: Int, stacked: Bool) -> Int { (stacked ? 1000 : 2000) + page }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let url = request.url!
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    let page = Int(items.first { $0.name == "page" }?.value ?? "0") ?? 0
    guard url.path == "/api/search/facets" else {
      let rows = (0..<50).map {
        #"{"id":"fs:/p/\#(page)-\#($0).dng","folder_id":"lib","abs_path":"/p/\#(page)-\#($0).dng","filename":"\#(page)-\#($0).dng"}"#
      }
      respond(
        #"{"results":[\#(rows.joined(separator: ","))],"total":\#((page + 1) * 50 + 1),"more":true,"page":\#(page),"limit":50}"#
      )
      return
    }
    let stacked = items.contains { $0.name == "stack" && $0.value == "1" }
    let gate = Self.gate
    gate.record(WindowFetch(page: page, stacked: stacked))
    let body =
      #"{"total":\#(Self.facetTotal(page: page, stacked: stacked)),"cameras":[],"lenses":[],"extensions":[],"scene_types":[],"activities":[],"subjects":[],"is_screenshot":{"true":0,"false":1,"unknown":0},"people":[],"places":[]}"#
    guard page > 0 else {
      respond(body)
      return
    }
    DispatchQueue.global().async {
      gate.pass()
      self.respond(body)
    }
  }

  override func stopLoading() {}

  private func respond(_ json: String) {
    let response = HTTPURLResponse(
      url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(json.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
}
