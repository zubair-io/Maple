import FileProvider
import XCTest

@testable import MapleCore

/// #5929, #5930: a server with `stack_pair_ops_supported` moves, renames and trashes a stack in one
/// request, so the client sends the pair and leaves the guarantee to the server: no `file-meta`
/// pre-checks, no Trash of a displaced file, no rollback. An older server keeps the two-call path.
extension RawJpegStackServerTests {
  private var probe: String { "GET /api/display/config" }

  private func calls(_ recorder: Recorder) -> [String] {
    recorder.requests.map { "\($0.method) \($0.path)" }
  }

  private func pairMoved(_ request: URLRequest) -> (Data, HTTPURLResponse) {
    respond(
      request,
      json: """
        {"new_abs_path":"/srv/photos/Library/Album/IMG_1.CR3","new_path":"Album",
         "new_filename":"IMG_1.CR3","renamed_on_collision":false,
         "companion":{"new_abs_path":"/srv/photos/Library/Album/IMG_1.JPG","new_path":"Album",
                      "new_filename":"IMG_1.JPG"}}
        """)
  }

  private func skipped(_ request: URLRequest, on name: String) -> (Data, HTTPURLResponse) {
    respond(
      request, json: #"{"skipped":true,"reason":"collision","collision_filename":"\#(name)"}"#)
  }

  private func companionGone(_ request: URLRequest) -> (Data, HTTPURLResponse) {
    respond(
      request, status: 404,
      json: #"{"error":"Companion not found beside the asset","missing":"companion"}"#)
  }

  /// `GET /api/assets/<rawID>`: the RAW live at `places`.
  private func rawAsset(_ request: URLRequest, places: [String] = ["Trip"]) -> (
    Data, HTTPURLResponse
  ) {
    let locations = places.map {
      #"{"path":"\#($0)","filename":"IMG_1.CR3","library_id":"f1","deleted_at":null}"#
    }
    return respond(
      request,
      json: """
        {"id":"\(rawID)","folder_id":"f1","filename":"IMG_1.CR3",
         "abs_path":"\(libPath)/\(places[0])/IMG_1.CR3",
         "fileinfo":[\(locations.joined(separator: ","))],"size":2,"mtime":0,"rating":0}
        """)
  }

  private func move(
    _ catalog: RemoteCatalog, collision: CollisionPolicy = .replace,
    companionCollision: CollisionPolicy = .fail
  ) async throws -> RelocateAssetResult {
    try await catalog.relocateAsset(
      assetID: rawID, mode: .move, collision: collision, destinationPath: "Album",
      sourceAddress: "lib:Trip/IMG_1.CR3", stack: stack, libraryFolderID: "f1",
      restore: ("Trip", "IMG_1.CR3"), companionCollision: companionCollision)
  }

  // MARK: - Move

  func testAPairServerMovesTheStackInOneRequest() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder, pairOps: true) { _, request in self.pairMoved(request) }

    let result = try await move(catalog)

    guard case .ok(let moved) = result else { return XCTFail("expected a move, got \(result)") }
    XCTAssertEqual(moved.newFilename, "IMG_1.CR3")
    XCTAssertEqual(calls(recorder), [probe, "POST /api/assets/\(rawID)/relocate"])
    let body = try XCTUnwrap(recorder.requests.last?.body)
    XCTAssertEqual(body["companion_id"] as? String, jpegID)
    XCTAssertEqual(
      body["companion_collision"] as? String, "skip",
      "Replace on the RAW's prompt must not replace an unrelated JPEG")
    XCTAssertEqual(body["collision"] as? String, "replace")
    XCTAssertEqual(body["mode"] as? String, "move")
    XCTAssertEqual(body["destination_path"] as? String, "Album")
    XCTAssertEqual(body["source_address"] as? String, "lib:Trip/IMG_1.CR3")
    XCTAssertNil(body["destination_filename"])
  }

  func testAPairServerReplacesTheJpegOnlyWhenItsOwnPromptSaidSoAndNeverUnderKeepBoth() async throws
  {
    for (collision, wire, companion) in [
      (CollisionPolicy.replace, "replace", "replace"), (.fail, "skip", "replace"),
      (.autoSuffix, "keep-both", "skip"),
    ] {
      let recorder = Recorder()
      let catalog = catalog(recorder, pairOps: true) { _, request in self.pairMoved(request) }

      _ = try await move(catalog, collision: collision, companionCollision: .replace)

      XCTAssertEqual(calls(recorder), [probe, "POST /api/assets/\(rawID)/relocate"])
      let body = try XCTUnwrap(recorder.requests.last?.body)
      XCTAssertEqual(body["collision"] as? String, wire)
      XCTAssertEqual(body["companion_collision"] as? String, companion, "RAW policy \(wire)")
    }
  }

  func testAPairSkippedOnTheJpegsNameAsksAboutTheJpeg() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder, pairOps: true) { _, request in
      self.skipped(request, on: "IMG_1.JPG")
    }

    do {
      _ = try await move(catalog)
      XCTFail("the JPEG's name is taken")
    } catch FileOperationError.destinationExists(let name) {
      XCTAssertEqual(name, "IMG_1.JPG")
    }
    XCTAssertEqual(calls(recorder), [probe, "POST /api/assets/\(rawID)/relocate"])
  }

  func testAPairSkippedOnTheRawsNameComesBackSkipped() async throws {
    for replacingJpeg in [false, true] {
      let recorder = Recorder()
      let catalog = catalog(recorder, pairOps: true) { _, request in
        self.skipped(request, on: "IMG_1.CR3")
      }

      let result = try await move(
        catalog, collision: .fail, companionCollision: replacingJpeg ? .replace : .fail)

      XCTAssertEqual(result, .skipped(reason: "collision"))
    }
  }

  func testAPairWhoseJpegIsGoneReportsTheJpegMissing() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder, pairOps: true) { record, request in
      record.method == "GET" ? self.rawAsset(request) : self.companionGone(request)
    }

    for action in ["move", "rename", "trash"] {
      do {
        switch action {
        case "move": _ = try await move(catalog)
        case "rename":
          _ = try await catalog.renameAsset(assetID: rawID, newFilename: "Beach.CR3", stack: stack)
        default:
          _ = try await catalog.deleteAsset(
            assetID: rawID, intent: .trash, stack: stack, libraryFolderID: "f1",
            primaryAbsPath: rawAbsPath)
        }
        XCTFail("\(action): the JPEG is gone")
      } catch FileOperationError.sourceMissing(let name) {
        XCTAssertEqual(name, "IMG_1.JPG", action)
      }
    }
  }

  func testAPairServersRefusedReplaceKeepsTheExistingConflictMapping() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder, pairOps: true) { _, request in
      self.respond(
        request, status: 409,
        json: #"{"error":"occupied","occupied_by_asset_id":"x","occupied_filename":"IMG_1.JPG"}"#)
    }

    do {
      _ = try await move(catalog, companionCollision: .replace)
      XCTFail("an indexed photo holds the JPEG's name")
    } catch {
      XCTAssertEqual((error as NSError).domain, NSFileProviderErrorDomain)
      XCTAssertEqual((error as NSError).code, NSFileProviderError.filenameCollision.rawValue)
    }
  }

  /// A display config the server cannot answer reads as an older server: the stack takes the
  /// two-call path, never the pair fields an older server would ignore.
  func testAServerThatCannotBeAskedGetsTheTwoCallMove() async throws {
    let recorder = Recorder()
    let session = URLSession.stubbedSequence { request in
      let bodyData = URLProtocolStub.capturedBodies[request.url?.absoluteString ?? ""] ?? Data()
      recorder.requests.append(
        Request(
          method: request.httpMethod ?? "GET", path: request.url?.path ?? "", query: nil,
          body: (try? JSONSerialization.jsonObject(with: bodyData)) as? [String: Any] ?? [:]))
      if request.url?.path == "/api/display/config" {
        return self.respond(request, status: 500, json: #"{"error":"down"}"#)
      }
      if request.url?.path == "/api/folders/f1/file-meta" {
        return self.fileMeta(request, taken: [])
      }
      let isRaw = request.url?.path.contains(self.rawID) == true
      return self.moved(request, path: "Album", filename: isRaw ? "IMG_1.CR3" : "IMG_1.JPG")
    }
    let catalog = RemoteCatalog(
      http: AuthenticatedHTTPClient.unauthenticated(
        server: URL(string: "https://example.test")!, urlSession: session),
      server: URL(string: "https://example.test")!)

    _ = try await move(catalog)

    let relocations = recorder.requests.filter { $0.path.hasSuffix("/relocate") }
    XCTAssertEqual(
      relocations.map(\.path), ["/api/assets/\(rawID)/relocate", "/api/assets/\(jpegID)/relocate"])
    XCTAssertTrue(relocations.allSatisfy { $0.body["companion_id"] == nil })
  }

  func testOnlyAServerThatSaysSoTakesPairRequests() throws {
    let older = try JSONDecoder().decode(
      DisplayConfig.self, from: Data(#"{"show_hidden_images":false,"stack_raw_jpeg":true}"#.utf8))
    let newer = try JSONDecoder().decode(
      DisplayConfig.self,
      from: Data(#"{"show_hidden_images":false,"stack_pair_ops_supported":true}"#.utf8))

    XCTAssertFalse(older.stackPairOpsSupported)
    XCTAssertTrue(newer.stackPairOpsSupported)
  }

  // MARK: - Rename

  func testAPairServerRenamesTheStackInOneRequest() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder, pairOps: true) { _, request in
      self.respond(
        request,
        json: """
          {"new_abs_path":"/srv/photos/Library/Trip/Beach.CR3","new_path":"Trip",
           "new_filename":"Beach.CR3","renamed_on_collision":false,"extension_changed":false,
           "companion":{"new_abs_path":"/srv/photos/Library/Trip/Beach.JPG","new_path":"Trip",
                        "new_filename":"Beach.JPG"}}
          """)
    }

    let result = try await catalog.renameAsset(
      assetID: rawID, newFilename: "Beach.CR3", stack: stack)

    guard case .ok(let renamed) = result else { return XCTFail("rename failed: \(result)") }
    XCTAssertEqual(renamed.newFilename, "Beach.CR3")
    XCTAssertEqual(calls(recorder), [probe, "POST /api/assets/\(rawID)/rename"])
    let body = try XCTUnwrap(recorder.requests.last?.body)
    XCTAssertEqual(body["new_filename"] as? String, "Beach.CR3")
    XCTAssertEqual(body["collision"] as? String, "skip")
    XCTAssertEqual(body["companion_id"] as? String, jpegID)
    XCTAssertEqual(body["companion_collision"] as? String, "skip")
  }

  func testAPairRenameSkippedOnTheJpegsNewNameNamesTheJpeg() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder, pairOps: true) { _, request in
      self.skipped(request, on: "Beach.JPG")
    }

    do {
      _ = try await catalog.renameAsset(assetID: rawID, newFilename: "Beach.CR3", stack: stack)
      XCTFail("the JPEG's new name is taken")
    } catch FileOperationError.destinationExists(let name) {
      XCTAssertEqual(name, "Beach.JPG")
    }
    XCTAssertEqual(calls(recorder), [probe, "POST /api/assets/\(rawID)/rename"])
  }

  // MARK: - Trash

  func testAPairServerTrashesTheStackInOneRequest() async throws {
    for (status, json, expected) in [
      (204, "", DeleteAssetResult.ok),
      (
        409, #"{"error":"Asset is already trashed","state":"trashed"}"#,
        .stateMismatch(state: "trashed")
      ),
    ] {
      let recorder = Recorder()
      let catalog = catalog(recorder, pairOps: true) { record, request in
        record.method == "GET"
          ? self.rawAsset(request) : self.respond(request, status: status, json: json)
      }

      let result = try await catalog.deleteAsset(
        assetID: rawID, intent: .trash, stack: stack, libraryFolderID: "f1",
        primaryAbsPath: rawAbsPath)

      XCTAssertEqual(result, expected)
      XCTAssertEqual(
        calls(recorder),
        [probe, "GET /api/assets/\(rawID)", "DELETE /api/assets/\(rawID)"],
        "no file-meta lookups of the library's Trash")
      XCTAssertEqual(recorder.requests.last?.query, "intent=trash&companion=\(jpegID)")
    }
  }

  /// Review of #5947: the server's pair trash takes no location and trashes the pair beside the
  /// RAW copy it picks, so with the RAW in several places it could trash another folder's pair
  /// and leave the listed one. That trash is refused before anything moves; a JPEG in several
  /// places is not, since the server takes the one beside the RAW.
  func testAPairServersTrashIsRefusedWhenTheRawIsInSeveralPlaces() async throws {
    for (places, refused) in [(["Album", "Trip"], true), (["Trip"], false)] {
      let recorder = Recorder()
      let catalog = catalog(recorder, pairOps: true) { record, request in
        if record.method == "GET" { return self.rawAsset(request, places: places) }
        return self.respond(request, status: 204, json: "")
      }

      do {
        let result = try await catalog.deleteAsset(
          assetID: rawID, intent: .trash, stack: stack, libraryFolderID: "f1",
          primaryAbsPath: rawAbsPath)
        XCTAssertFalse(refused, "a RAW in \(places) must refuse the pair trash")
        XCTAssertEqual(result, .ok)
      } catch FileOperationError.unsupportedSource(let message) {
        XCTAssertTrue(refused, message)
        XCTAssertTrue(message.contains("IMG_1.CR3"), message)
      }
      XCTAssertEqual(
        recorder.requests.filter { $0.method == "DELETE" }.count, refused ? 0 : 1, "\(places)")
    }
  }

  func testPurgeStaysOneAssetPerRequestOnAPairServer() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder, pairOps: true) { _, request in
      self.respond(request, status: 204, json: "")
    }

    let result = try await catalog.deleteAsset(
      assetID: rawID, intent: .purge, stack: stack, libraryFolderID: "f1",
      primaryAbsPath: rawAbsPath)

    XCTAssertEqual(result, .ok)
    XCTAssertEqual(
      calls(recorder), ["DELETE /api/assets/\(rawID)", "DELETE /api/assets/\(jpegID)"])
    XCTAssertEqual(recorder.requests.map(\.query), ["intent=purge", "intent=purge"])
  }
}
