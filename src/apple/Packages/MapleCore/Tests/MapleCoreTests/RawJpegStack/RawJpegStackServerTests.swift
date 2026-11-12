import XCTest

@testable import MapleCore

/// #5050 review: a stacked tile on a Self Hosted library is one tile but two server assets. The
/// RAW's collision choice never reaches the JPEG, a JPEG that cannot follow puts the RAW back by
/// the address the move gave it, trash never leaves the tile half trashed, and only stack-aware
/// views ask the server to fold pairs.
final class RawJpegStackServerTests: XCTestCase {
  private let server = URL(string: "https://example.test")!
  private let rawID = "650a1b2c3d4e5f6071829301"
  private let jpegID = "650a1b2c3d4e5f6071829302"
  private let libPath = "/srv/photos/Library"

  private struct Request {
    let method: String
    let path: String
    let query: String?
    let body: [String: Any]
  }

  private final class Recorder: @unchecked Sendable {
    var requests: [Request] = []
  }

  private var stack: RawJpegStack {
    RawJpegStack(
      primary: .init(name: "IMG_1.CR3", size: 3), companion: .init(name: "IMG_1.JPG", size: 2),
      location: .cloud(
        address: "lib:Trip/IMG_1.JPG", path: "/srv/photos/Library/Trip/IMG_1.JPG", id: jpegID))
  }

  private func respond(_ request: URLRequest, status: Int = 200, json: String) -> (
    Data, HTTPURLResponse
  ) {
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": "application/json"])!
    return (Data(json.utf8), response)
  }

  private func catalog(
    _ recorder: Recorder, _ answer: @escaping (Request, URLRequest) -> (Data, HTTPURLResponse)
  ) -> RemoteCatalog {
    let session = URLSession.stubbedSequence { request in
      let bodyData = URLProtocolStub.capturedBodies[request.url?.absoluteString ?? ""] ?? Data()
      let body = (try? JSONSerialization.jsonObject(with: bodyData)) as? [String: Any] ?? [:]
      let record = Request(
        method: request.httpMethod ?? "GET", path: request.url?.path ?? "",
        query: request.url?.query, body: body)
      recorder.requests.append(record)
      return answer(record, request)
    }
    return RemoteCatalog(
      http: AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session),
      server: server)
  }

  private func moved(_ request: URLRequest, path: String, filename: String) -> (
    Data, HTTPURLResponse
  ) {
    respond(
      request,
      json: """
        {"new_abs_path":"/srv/photos/Library/\(path)/\(filename)","new_path":"\(path)",
         "new_filename":"\(filename)","renamed_on_collision":false}
        """)
  }

  /// `file-meta` for a library-relative path: a file when `taken` holds it, else 404.
  private func fileMeta(_ request: URLRequest, taken: Set<String>) -> (Data, HTTPURLResponse) {
    let path =
      URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
      .queryItems?.first { $0.name == "path" }?.value ?? ""
    return taken.contains(path)
      ? respond(
        request,
        json: #"{"name":"x","path":"/x","size":1,"mtime":"2026-01-01T00:00:00Z","ext":"jpg"}"#)
      : respond(request, status: 404, json: #"{"error":"file not found"}"#)
  }

  // MARK: - Relocate

  func testReplaceOnTheRawSendsTheJpegWithItsOwnDetectOnlyPolicy() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { record, request in
      if record.path == "/api/folders/f1/file-meta" { return self.fileMeta(request, taken: []) }
      return self.moved(
        request, path: "Album",
        filename: record.path.contains(self.rawID) ? "IMG_1.CR3" : "IMG_1.JPG")
    }

    _ = try await catalog.relocateAsset(
      assetID: rawID, mode: .move, collision: .replace, destinationPath: "Album",
      sourceAddress: "lib:Trip/IMG_1.CR3", stack: stack, libraryFolderID: "f1",
      restore: ("Trip", "IMG_1.CR3"))

    let relocations = recorder.requests.filter { $0.path.hasSuffix("/relocate") }
    XCTAssertEqual(
      relocations.map(\.path),
      [
        "/api/assets/\(rawID)/relocate", "/api/assets/\(jpegID)/relocate",
      ])
    XCTAssertEqual(relocations[0].body["collision"] as? String, "replace")
    XCTAssertEqual(
      relocations[1].body["collision"] as? String, "skip",
      "Replace on the RAW's prompt must not replace an unrelated JPEG")
  }

  func testTheJpegIsReplacedOnlyWhenItsOwnPromptSaidSo() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { record, request in
      self.moved(
        request, path: "Album",
        filename: record.path.contains(self.rawID) ? "IMG_1.CR3" : "IMG_1.JPG")
    }

    _ = try await catalog.relocateAsset(
      assetID: rawID, mode: .move, collision: .replace, destinationPath: "Album",
      sourceAddress: nil, stack: stack, libraryFolderID: "f1", restore: ("Trip", "IMG_1.CR3"),
      companionCollision: .replace)

    XCTAssertEqual(recorder.requests.last?.body["collision"] as? String, "replace")
  }

  /// Replace answered for the RAW used to move it before the JPEG's name was looked at: the server
  /// deletes the file a Replace displaced once that asset commits, so skipping the JPEG's prompt
  /// that followed lost the unindexed file the RAW had replaced. Both names are now asked about
  /// before either file moves.
  func testATakenJpegNameStopsTheMoveBeforeTheRawReplacesAnything() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { record, request in
      if record.path == "/api/folders/f1/file-meta" {
        return self.fileMeta(request, taken: ["Album/IMG_1.JPG"])
      }
      if record.path.contains(self.jpegID), record.body["collision"] as? String == "skip" {
        return self.respond(request, json: #"{"skipped":true,"reason":"collision"}"#)
      }
      return self.moved(
        request, path: "Album",
        filename: record.path.contains(self.rawID) ? "IMG_1.CR3" : "IMG_1.JPG")
    }

    do {
      _ = try await catalog.relocateAsset(
        assetID: rawID, mode: .move, collision: .replace, destinationPath: "Album",
        sourceAddress: "lib:Trip/IMG_1.CR3", stack: stack, libraryFolderID: "f1",
        restore: ("Trip", "IMG_1.CR3"))
      XCTFail("the JPEG's name is taken")
    } catch FileOperationError.destinationExists(let name) {
      XCTAssertEqual(name, "IMG_1.JPG")
    }

    XCTAssertEqual(
      recorder.requests.filter { $0.path.hasSuffix("/relocate") }.map(\.path), [],
      "nothing moves, so nothing is replaced, until the JPEG's own prompt is answered")
  }

  /// The JPEG's name was free when asked, then taken by the time the JPEG moved: the RAW, which
  /// replaced nothing, goes back. The rollback used the RAW's pre-move address, which the server
  /// answers with 409 ("no longer belongs to this asset"), leaving the RAW at the destination and
  /// the JPEG at the source.
  func testAJpegThatCannotFollowPutsTheRawBackByItsMovedAddress() async throws {
    let recorder = Recorder()
    var rawAddress = "lib:Trip/IMG_1.CR3"
    let catalog = catalog(recorder) { record, request in
      if record.path == "/api/folders/f1/file-meta" { return self.fileMeta(request, taken: []) }
      if record.path.contains(self.jpegID) {
        return self.respond(request, json: #"{"skipped":true,"reason":"collision"}"#)
      }
      // The server resolves `source_address` against the asset's live location.
      if let sent = record.body["source_address"] as? String, sent != rawAddress {
        return self.respond(
          request, status: 409, json: #"{"error":"Source address no longer belongs to this asset"}"#
        )
      }
      let destination = record.body["destination_path"] as? String ?? ""
      let filename = record.body["destination_filename"] as? String ?? "IMG_1.CR3"
      rawAddress = "lib:\(destination)/\(filename)"
      return self.moved(request, path: destination, filename: filename)
    }

    do {
      _ = try await catalog.relocateAsset(
        assetID: rawID, mode: .move, collision: .fail, destinationPath: "Album",
        sourceAddress: "lib:Trip/IMG_1.CR3", stack: stack, libraryFolderID: "f1",
        restore: ("Trip", "IMG_1.CR3"))
      XCTFail("the JPEG's name is taken")
    } catch FileOperationError.destinationExists(let name) {
      XCTAssertEqual(name, "IMG_1.JPG")
    }

    let rollback = try XCTUnwrap(recorder.requests.last)
    XCTAssertEqual(rollback.path, "/api/assets/\(rawID)/relocate")
    XCTAssertEqual(rollback.body["source_address"] as? String, "lib:Album/IMG_1.CR3")
    XCTAssertEqual(rollback.body["destination_path"] as? String, "Trip")
    XCTAssertEqual(rawAddress, "lib:Trip/IMG_1.CR3", "the RAW is back where it started")
  }

  /// Keep Both with only `IMG_1.JPG` in the destination used to fail: the server's keep-both kept
  /// the free `IMG_1.CR3` for the RAW, the JPEG then collided under its own name and the move was
  /// rolled back, and the ask-flow never prompts again once Keep Both was chosen.
  func testKeepBothWithOnlyTheJpegNameTakenMovesBothToOneFreeStem() async throws {
    let recorder = Recorder()
    let occupied: Set<String> = ["Album/IMG_1.JPG"]
    let catalog = catalog(recorder) { record, request in
      if record.path == "/api/folders/f1/file-meta" {
        return self.fileMeta(request, taken: occupied)
      }
      let isJpeg = record.path.contains(self.jpegID)
      let filename =
        record.body["destination_filename"] as? String ?? (isJpeg ? "IMG_1.JPG" : "IMG_1.CR3")
      if occupied.contains("Album/\(filename)") {
        return self.respond(request, json: #"{"skipped":true,"reason":"collision"}"#)
      }
      return self.moved(request, path: "Album", filename: filename)
    }

    let result = try await catalog.relocateAsset(
      assetID: rawID, mode: .move, collision: .autoSuffix, destinationPath: "Album",
      sourceAddress: "lib:Trip/IMG_1.CR3", stack: stack, libraryFolderID: "f1",
      restore: ("Trip", "IMG_1.CR3"))

    guard case .ok(let moved) = result else { return XCTFail("expected a move, got \(result)") }
    XCTAssertEqual(moved.newFilename, "IMG_1.1.CR3")
    let relocations = recorder.requests.filter { $0.path.hasSuffix("/relocate") }
    XCTAssertEqual(
      relocations.map(\.path),
      ["/api/assets/\(rawID)/relocate", "/api/assets/\(jpegID)/relocate"],
      "no rollback")
    XCTAssertEqual(relocations[0].body["collision"] as? String, "keep-both")
    XCTAssertEqual(relocations[0].body["destination_filename"] as? String, "IMG_1.1.CR3")
    XCTAssertEqual(relocations[1].body["destination_filename"] as? String, "IMG_1.1.JPG")
  }

  func testTheMovedAddressKeepsTheLibraryAndFollowsTheNewLocation() {
    let moved = try! JSONDecoder().decode(
      RelocateAssetResponse.self,
      from: Data(
        #"{"new_abs_path":"/l/IMG_1.CR3","new_path":"","new_filename":"IMG_1.CR3","renamed_on_collision":false}"#
          .utf8))
    XCTAssertEqual(RemoteCatalog.address("lib:Trip/IMG_1.CR3", movedTo: moved), "lib:IMG_1.CR3")
    XCTAssertNil(RemoteCatalog.address("no-library", movedTo: moved))
  }

  // MARK: - Trash

  func testTrashGoesRawFirstAndARefusedJpegBringsTheRawBack() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { record, request in
      if record.method == "DELETE", record.path.contains(self.jpegID) {
        return self.respond(request, status: 409, json: #"{"error":"state","state":"trashed"}"#)
      }
      if record.path.hasSuffix("/restore") {
        return self.respond(request, json: #"{"abs_path":"/srv/photos/Library/Trip/IMG_1.CR3"}"#)
      }
      let response = HTTPURLResponse(
        url: request.url!, statusCode: 204, httpVersion: "HTTP/1.1", headerFields: nil)!
      return (Data(), response)
    }

    let result = try await catalog.deleteAsset(assetID: rawID, intent: .trash, stack: stack)

    XCTAssertEqual(result, .stateMismatch(state: "trashed"))
    XCTAssertEqual(
      recorder.requests.map { "\($0.method) \($0.path)" },
      [
        "DELETE /api/assets/\(rawID)", "DELETE /api/assets/\(jpegID)",
        "POST /api/assets/\(rawID)/restore",
      ])
  }

  func testARefusedRawLeavesTheJpegUntouched() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { _, request in
      self.respond(request, status: 409, json: #"{"error":"state","state":"purged"}"#)
    }

    let result = try await catalog.deleteAsset(assetID: rawID, intent: .trash, stack: stack)

    XCTAssertEqual(result, .stateMismatch(state: "purged"))
    XCTAssertEqual(recorder.requests.map(\.path), ["/api/assets/\(rawID)"])
  }

  // MARK: - Display config and `stack=1`

  func testAServerWithoutTheSettingReadsAsStackingOn() throws {
    let config = try JSONDecoder().decode(
      DisplayConfig.self, from: Data(#"{"show_hidden_images":false}"#.utf8))
    XCTAssertTrue(config.stackRawJpeg)
    let off = try JSONDecoder().decode(
      DisplayConfig.self,
      from: Data(#"{"show_hidden_images":true,"stack_raw_jpeg":false}"#.utf8))
    XCTAssertFalse(off.stackRawJpeg)
    XCTAssertTrue(off.showHiddenImages)
  }

  func testThePreferenceIsReadOnceAndSettingsOverwriteIt() async {
    let preference = ServerRawJpegStackPreference()
    let calls = Recorder()
    let fetch: @Sendable () async throws -> DisplayConfig = {
      calls.requests.append(Request(method: "GET", path: "", query: nil, body: [:]))
      return DisplayConfig(showHiddenImages: false, stackRawJpeg: false)
    }

    let first = await preference.isEnabled(server: server, fetch: fetch)
    let second = await preference.isEnabled(server: server, fetch: fetch)
    await preference.record(true, server: server)
    let third = await preference.isEnabled(server: server, fetch: fetch)

    XCTAssertEqual([first, second, third], [false, false, true])
    XCTAssertEqual(calls.requests.count, 1)
  }

  func testAnUnreachableServerDefaultsToStackingOnAndAsksAgainNextTime() async {
    let preference = ServerRawJpegStackPreference()
    let calls = Recorder()
    let fetch: @Sendable () async throws -> DisplayConfig = {
      calls.requests.append(Request(method: "GET", path: "", query: nil, body: [:]))
      throw URLError(.notConnectedToInternet)
    }

    let first = await preference.isEnabled(server: server, fetch: fetch)
    let second = await preference.isEnabled(server: server, fetch: fetch)

    XCTAssertEqual([first, second], [true, true])
    XCTAssertEqual(calls.requests.count, 2)
  }

  private func folderSession(_ recorder: Recorder) -> URLSession {
    URLSession.stubbedSequence { request in
      recorder.requests.append(
        Request(
          method: request.httpMethod ?? "GET", path: request.url?.path ?? "",
          query: request.url?.query, body: [:]))
      if request.url?.path == "/api/folders" {
        return self.respond(
          request,
          json: """
            [{"id":"f1","slug":"library","path":"\(self.libPath)","label":"Library",
              "last_scan":null,"file_count":1,"created_at":"2026-01-01T00:00:00Z"}]
            """)
      }
      if request.url?.path == "/api/display/config" {
        return self.respond(request, json: #"{"show_hidden_images":false,"stack_raw_jpeg":false}"#)
      }
      return self.respond(
        request, json: #"{"path":"\#(self.libPath)","parentPath":null,"folders":[],"images":[]}"#)
    }
  }

  func testOnlyAStackAwareListingAsksTheServerToFold() async throws {
    let recorder = Recorder()
    let source = CloudSource(
      server: server, folderID: "f1", libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(
        server: server, urlSession: folderSession(recorder)))

    _ = try await source.listDir(absPath: libPath)
    _ = try await source.listDir(absPath: libPath, stackRawJpeg: true)
    _ = try await source.images()

    let listings = recorder.requests.filter { $0.path == "/api/folder/library" }
    XCTAssertEqual(listings.map(\.query), [nil, "stack=1", nil])
  }

  @MainActor
  func testTheGridSendsStackOnlyWhenTheServersPreferenceIsOn() async throws {
    for preference in [true, false] {
      let recorder = Recorder()
      let identity = URL(string: "https://grid-\(preference).example")!
      await ServerRawJpegStackPreference.shared.record(preference, server: identity)
      let source = CloudSource(
        server: server, identity: identity, folderID: "f1", libraryPath: libPath,
        httpClient: AuthenticatedHTTPClient.unauthenticated(
          server: server, urlSession: folderSession(recorder)))

      await BrowseViewModel().loadCloudDir(source, absPath: libPath)

      let listing = try XCTUnwrap(recorder.requests.last { $0.path == "/api/folder/library" })
      XCTAssertEqual(listing.query, preference ? "stack=1" : nil, "preference \(preference)")
    }
  }

  func testTheGridReadsTheServersPreferenceWhenSettingsHasNotYet() async throws {
    let recorder = Recorder()
    let source = CloudSource(
      server: server, identity: URL(string: "https://unread.example")!, folderID: "f1",
      libraryPath: libPath,
      httpClient: AuthenticatedHTTPClient.unauthenticated(
        server: server, urlSession: folderSession(recorder)))

    let enabled = await source.stacksRawJpegPairs()

    XCTAssertFalse(enabled, "the stub server keeps stack_raw_jpeg off")
    XCTAssertEqual(recorder.requests.map(\.path), ["/api/display/config"])
  }
}
