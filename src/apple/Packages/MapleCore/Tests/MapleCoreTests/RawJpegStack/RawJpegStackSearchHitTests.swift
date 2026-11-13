import XCTest

@testable import MapleCore

/// #5849: a Self Hosted timeline or search hit for a RAW carries the JPEG the server folded into
/// it as `stack.companion`, and the timeline and search refs carry it as the listing's do.
final class RawJpegStackSearchHitTests: XCTestCase {
  private let responseJSON = """
    {"total":2,"page":0,"limit":200,"results":[
      {"id":"fs:/srv/photos/Library/Trip/IMG_1.CR3","folder_id":"f1",
       "abs_path":"/srv/photos/Library/Trip/IMG_1.CR3","address":"lib:Trip/IMG_1.CR3",
       "filename":"IMG_1.CR3","size":300,"mtime":1767225600000,"owner_id":null,"owner":null,
       "stack":{"companion":{"id":"0123456789abcdef01234567","name":"IMG_1.JPG",
         "address":"lib:Trip/IMG_1.JPG","path":"/srv/photos/Library/Trip/IMG_1.JPG","size":120,
         "mtime":"2026-01-01T00:00:00.000Z","ext":"jpg"}}},
      {"id":"fs:/srv/photos/Library/Trip/IMG_2.CR3","folder_id":"f1",
       "abs_path":"/srv/photos/Library/Trip/IMG_2.CR3","address":"lib:Trip/IMG_2.CR3",
       "filename":"IMG_2.CR3","size":50,"mtime":1767225600000,"owner_id":null,"owner":null}]}
    """

  private func results() throws -> [SearchAsset] {
    try JSONDecoder().decode(SearchResponse.self, from: Data(responseJSON.utf8)).results
  }

  func testAResponseDecodesTheCompanionOnTheRawHitOnly() throws {
    let results = try results()

    XCTAssertEqual(
      results[0].stack?.companion,
      SearchAssetStackCompanion(
        id: "0123456789abcdef01234567", name: "IMG_1.JPG", address: "lib:Trip/IMG_1.JPG",
        path: "/srv/photos/Library/Trip/IMG_1.JPG", size: 120, mtime: "2026-01-01T00:00:00.000Z",
        ext: "jpg"))
    XCTAssertNil(results[1].stack)
  }

  func testTheHitsStackCarriesBothFilesAndTheCompanionsServerLocation() throws {
    let hit = try XCTUnwrap(results().first)

    let stack = try XCTUnwrap(RawJpegStacking.cloudStack(for: hit))

    XCTAssertEqual(stack.primary, .init(name: "IMG_1.CR3", size: 300))
    XCTAssertEqual(stack.companion, .init(name: "IMG_1.JPG", size: 120))
    XCTAssertEqual(
      stack.location,
      .cloud(
        address: "lib:Trip/IMG_1.JPG", path: "/srv/photos/Library/Trip/IMG_1.JPG",
        id: "0123456789abcdef01234567"))
    XCTAssertEqual(stack.infoRows.map(\.name), ["IMG_1.CR3", "IMG_1.JPG"])
  }

  func testAHitWithoutAStackCarriesNone() throws {
    XCTAssertNil(RawJpegStacking.cloudStack(for: try results()[1]))
  }

  /// A companion whose library has no slug has no `address`. It used to be dropped, so the JPEG
  /// the server had folded away was invisible and left behind by move, rename and trash.
  func testAnUnaddressedCompanionIsStillCarriedByItsID() throws {
    let unaddressed = SearchAsset(
      id: "fs:/l/IMG_3.NEF", folder_id: "f1", abs_path: "/l/IMG_3.NEF", filename: "IMG_3.NEF",
      size: 9,
      stack: SearchAssetStack(
        companion: SearchAssetStackCompanion(
          id: jpegID, name: "IMG_3.JPG", address: nil, path: "/l/IMG_3.JPG", size: 4,
          mtime: "2026-01-01T00:00:00.000Z", ext: "jpg")))

    let stack = try XCTUnwrap(RawJpegStacking.cloudStack(for: unaddressed))

    XCTAssertEqual(stack.location, .cloud(address: nil, path: "/l/IMG_3.JPG", id: jpegID))
    XCTAssertEqual(stack.infoRows.map(\.name), ["IMG_3.NEF", "IMG_3.JPG"])
  }

  // MARK: - Acting on a hit's stack

  private let server = URL(string: "https://example.test")!
  private let rawID = "650a1b2c3d4e5f6071829301"
  private let jpegID = "650a1b2c3d4e5f6071829302"

  private final class Recorder: @unchecked Sendable {
    var requests: [(method: String, path: String, query: String?, body: [String: Any])] = []
  }

  private func session(
    _ recorder: Recorder, json: @escaping (String) -> String = { _ in "{}" }
  ) -> URLSession {
    URLSession.stubbedSequence { request in
      let data = URLProtocolStub.capturedBodies[request.url?.absoluteString ?? ""] ?? Data()
      let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
      let path = request.url?.path ?? ""
      recorder.requests.append((request.httpMethod ?? "GET", path, request.url?.query, body))
      // No file sits under the JPEG's name in the destination.
      let response = HTTPURLResponse(
        url: request.url!, statusCode: path.hasSuffix("/file-meta") ? 404 : 200,
        httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
      return (Data(json(path).utf8), response)
    }
  }

  private func unaddressedStack() -> RawJpegStack {
    RawJpegStack(
      primary: .init(name: "IMG_3.NEF", size: 9), companion: .init(name: "IMG_3.JPG", size: 4),
      location: .cloud(address: nil, path: "/l/IMG_3.JPG", id: jpegID))
  }

  func testMovingAHitsStackCarriesAnUnaddressedJpegByItsID() async throws {
    let recorder = Recorder()
    let catalog = RemoteCatalog(
      http: AuthenticatedHTTPClient.unauthenticated(
        server: server,
        urlSession: session(recorder) { path in
          let name = path.contains(self.rawID) ? "IMG_3.NEF" : "IMG_3.JPG"
          return """
            {"new_abs_path":"/l/Album/\(name)","new_path":"Album","new_filename":"\(name)",
             "renamed_on_collision":false}
            """
        }),
      server: server)

    let result = try await catalog.relocateAsset(
      assetID: rawID, mode: .move, collision: .fail, destinationPath: "Album",
      sourceAddress: "lib:IMG_3.NEF", stack: unaddressedStack(), libraryFolderID: "f1",
      restore: ("", "IMG_3.NEF"))

    guard case .ok = result else { return XCTFail("expected the pair to move, got \(result)") }
    XCTAssertEqual(
      recorder.requests.map(\.path),
      [
        "/api/folders/f1/file-meta", "/api/assets/\(rawID)/relocate",
        "/api/assets/\(jpegID)/relocate",
      ])
    XCTAssertEqual(recorder.requests[1].body["source_address"] as? String, "lib:IMG_3.NEF")
    XCTAssertNil(recorder.requests[2].body["source_address"], "the JPEG is addressed by id")
  }

  /// The trash first asks the library's Trash about the pair's names (#5930), found from the RAW's
  /// path in its library, since an unaddressed JPEG names no folder.
  func testTrashingAHitsStackTrashesTheUnaddressedJpegToo() async throws {
    let recorder = Recorder()
    let catalog = RemoteCatalog(
      http: AuthenticatedHTTPClient.unauthenticated(
        server: server,
        urlSession: session(recorder) { path in
          switch path {
          case "/api/folders":
            return #"[{"id":"f1","path":"/l","label":"L","file_count":2}]"#
          case "/api/assets/\(self.jpegID)":
            // The JPEG lives at one location, so the server's trash can only move that copy.
            return #"{"id":"\#(self.jpegID)","folder_id":"f1","filename":"IMG_3.JPG","#
              + #""abs_path":"/l/Trip/IMG_3.JPG","fileinfo":[{"path":"Trip","filename":"#
              + #""IMG_3.JPG","library_id":"f1"}],"size":4,"mtime":0,"rating":0}"#
          default:
            return "{}"
          }
        }),
      server: server)

    let result = try await catalog.deleteAsset(
      assetID: rawID, intent: .trash, stack: unaddressedStack(), libraryFolderID: "f1",
      primaryAbsPath: "/l/Trip/IMG_3.NEF")

    XCTAssertEqual(result, .ok)
    XCTAssertEqual(
      recorder.requests.filter { $0.path.hasSuffix("/file-meta") }.compactMap(\.query),
      ["IMG_3.NEF", "IMG_3.JPG", "IMG_3.xmp"].map { "path=.maple/trash/Trip/\($0)" })
    XCTAssertEqual(
      recorder.requests.filter { $0.method != "GET" }.map { "\($0.method) \($0.path)" },
      ["DELETE /api/assets/\(rawID)", "DELETE /api/assets/\(jpegID)"])
  }

  func testRenamingAHitsStackKeepsTheJpegsMissingAddressMissing() throws {
    let response = try JSONDecoder().decode(
      RenameAssetResponse.self,
      from: Data(
        #"{"new_abs_path":"/l/Trip.NEF","new_path":"","new_filename":"Trip.NEF","renamed_on_collision":false,"extension_changed":false}"#
          .utf8))

    let renamed = unaddressedStack().relocatedCloud(afterRenameTo: response)

    XCTAssertEqual(renamed.location, .cloud(address: nil, path: "/l/Trip.JPG", id: jpegID))
    XCTAssertEqual(renamed.companion.name, "Trip.JPG")
  }

  // MARK: - `stack=1`

  func testOnlyAStackAwareSearchClientAsksTheServerToFold() async throws {
    for (reader, expected) in [
      (nil, false), ({ @Sendable in true }, true), ({ @Sendable in false }, false),
    ] as [((@Sendable () async -> Bool)?, Bool)] {
      let recorder = Recorder()
      let client = CloudSearchClient(
        server: server,
        httpClient: AuthenticatedHTTPClient.unauthenticated(
          server: server, urlSession: session(recorder)),
        stacksRawJpeg: reader)
      let params = SearchParams(libraryID: "f1")

      _ = try? await client.buckets(libraryID: "f1")
      _ = try? await client.page(libraryID: "f1", year: 2026, month: 1)
      _ = try? await client.search(params, page: 0, limit: 10)
      _ = try? await client.facets(params)

      XCTAssertEqual(
        recorder.requests.map(\.path),
        ["/api/search/buckets", "/api/search", "/api/search", "/api/search/facets"])
      for request in recorder.requests {
        let items = URLComponents(string: "x:/?\(request.query ?? "")")?.queryItems ?? []
        XCTAssertEqual(
          items.contains(URLQueryItem(name: "stack", value: "1")), expected,
          "\(request.path) with reader \(String(describing: reader))")
      }
    }
  }

  func testAHitRoundTripsItsStackThroughEncoding() throws {
    let hit = try XCTUnwrap(results().first)

    let decoded = try JSONDecoder().decode(SearchAsset.self, from: JSONEncoder().encode(hit))

    XCTAssertEqual(decoded, hit)
    XCTAssertNotNil(decoded.stack)
  }
}
