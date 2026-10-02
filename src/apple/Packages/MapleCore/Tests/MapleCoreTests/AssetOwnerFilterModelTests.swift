import XCTest

@testable import MapleCore

@MainActor
final class AssetOwnerFilterModelTests: XCTestCase {
  func testScopedOptionsKeepSelectedEmailThroughZeroResultsAndRetry() async throws {
    let server = URL(string: "https://example.test")!
    nonisolated(unsafe) var attempt = 0
    nonisolated(unsafe) var urls: [URL] = []
    let session = URLSession.stubbedSequence { request in
      urls.append(request.url!)
      attempt += 1
      let body =
        attempt == 1
        ? #"{"total":2,"owners":[{"id":"me","email":"me@test","count":1},{"id":"member","email":" member@test ","count":1}]}"#
        : #"{"total":0,"owners":[]}"#
      return (
        Self.facetData(body),
        HTTPURLResponse(
          url: request.url!, statusCode: attempt == 3 ? 503 : 200,
          httpVersion: nil, headerFields: nil)!
      )
    }
    let client = CloudSearchClient(
      server: server,
      httpClient: .unauthenticated(server: server, urlSession: session))
    let model = AssetOwnerFilterModel(searchClient: client, currentUserID: "me")
    var params = SearchParams(libraryID: "library")
    params.pathPrefix = "folder/"
    params.ownerID = "member"
    params.people = ["Ada"]
    await model.load(params)
    XCTAssertEqual(
      model.options(selectedID: "member").map(\.label),
      ["All owners", "Only my uploads", "member@test"])
    XCTAssertEqual(model.options(selectedID: "member").filter { $0.id == "me" }.count, 1)
    let items = URLComponents(url: try XCTUnwrap(urls.first), resolvingAgainstBaseURL: false)!
      .queryItems!
    let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
    XCTAssertNil(query["ownerId"])
    XCTAssertEqual(query["libraryId"], "library")
    XCTAssertEqual(query["pathPrefix"], "folder/")
    XCTAssertEqual(query["people"], "Ada")
    params.people = ["No matches"]
    await model.load(params)
    XCTAssertEqual(model.options(selectedID: "member").last?.label, "member@test")
    await model.load(params)
    XCTAssertNotNil(model.loadError)
    XCTAssertFalse(model.isLoading)
    XCTAssertEqual(model.options(selectedID: "member").last?.label, "member@test")
    await model.load(params)
    XCTAssertNil(model.loadError)
    XCTAssertEqual(attempt, 4)
  }

  func testLegacyFacetsAndMissingAccountOfferOnlyRealSelections() async {
    let server = URL(string: "https://example.test")!
    let session = URLSession.stubbed(
      response: String(decoding: Self.facetData(#"{"total":0}"#), as: UTF8.self))
    let client = CloudSearchClient(
      server: server,
      httpClient: .unauthenticated(server: server, urlSession: session))
    let model = AssetOwnerFilterModel(searchClient: client)
    await model.load(SearchParams())
    XCTAssertEqual(model.options(selectedID: nil).map(\.label), ["All owners"])
    XCTAssertEqual(model.options(selectedID: "real-id").last?.label, "real-id")
  }

  func testLateFacetResponseCannotReplaceTheNewFolder() async throws {
    let server = URL(string: "https://example.test")!
    let gate = OwnerRequestGate()
    addTeardownBlock { await gate.releaseAll() }
    let session = URLSession.stubbedSequence(
      onRequestStart: { await gate.enter() },
      { request in
        let folder = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
          .first { $0.name == "pathPrefix" }!.value!
        let body =
          "{\"total\":1,\"owners\":[{\"id\":\"\(folder)\",\"email\":\"\(folder)@test\",\"count\":1}]}"
        return (
          Self.facetData(body),
          HTTPURLResponse(
            url: request.url!, statusCode: 200,
            httpVersion: nil, headerFields: nil)!
        )
      })
    let client = CloudSearchClient(
      server: server,
      httpClient: .unauthenticated(server: server, urlSession: session))
    let model = AssetOwnerFilterModel(searchClient: client)
    var oldParams = SearchParams(libraryID: "library")
    oldParams.pathPrefix = "old"
    var newParams = oldParams
    newParams.pathPrefix = "new"
    let old = Task { await model.load(oldParams) }
    try await gate.waitForArrival(1)
    let new = Task { await model.load(newParams) }
    try await gate.waitForArrival(2)
    await gate.release(2)
    await new.value
    await gate.release(1)
    await old.value
    XCTAssertEqual(model.owners.map(\.id), ["new"])
    XCTAssertFalse(model.isLoading)
  }
  private nonisolated static func facetData(_ json: String) -> Data {
    let fields =
      #""cameras":[],"lenses":[],"extensions":[],"scene_types":[],"activities":[],"subjects":[],"is_screenshot":{"true":0,"false":0,"unknown":0},"#
    return Data(("{" + fields + json.dropFirst()).utf8)
  }
}

/// Deterministic response ordering: tests explicitly release each request.
actor OwnerRequestGate {
  private var count = 0
  private var releases: [Int: CheckedContinuation<Void, Never>] = [:]

  func enter() async {
    count += 1
    let index = count
    await withCheckedContinuation { continuation in
      releases[index] = continuation
    }
  }

  func waitForArrival(_ index: Int) async throws {
    for _ in 0..<500 {
      if count >= index { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw URLError(.timedOut)
  }

  func releaseAll() {
    for continuation in releases.values { continuation.resume() }
    releases = [:]
  }

  func release(_ index: Int) {
    releases.removeValue(forKey: index)?.resume()
  }
}
