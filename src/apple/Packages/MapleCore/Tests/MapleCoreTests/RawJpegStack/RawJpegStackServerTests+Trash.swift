import XCTest

@testable import MapleCore

/// #5050 review: a server stack trash goes RAW first, never leaves the tile half trashed, and is
/// refused before anything moves when the server could not trash the pair as listed.
extension RawJpegStackServerTests {
  /// The lookups a stacked trash makes before trashing: the library roots, `file-meta` for the
  /// library's Trash, which holds `inTrash`, and the JPEG's and RAW's assets, live at
  /// `jpegLocations` and `rawLocations`.
  private func trashLookup(
    _ record: Request, _ request: URLRequest, inTrash: Set<String> = [],
    jpegLocations: [String] = ["Trip"], rawLocations: [String] = ["Trip"]
  ) -> (Data, HTTPURLResponse)? {
    if record.path == "/api/folders" {
      return respond(
        request,
        json: """
          [{"id":"f1","slug":"library","path":"\(libPath)","label":"Library",
            "last_scan":null,"file_count":1,"created_at":"2026-01-01T00:00:00Z"}]
          """)
    }
    if record.path == "/api/folders/f1/file-meta" { return fileMeta(request, taken: inTrash) }
    for (id, name, places) in [
      (jpegID, "IMG_1.JPG", jpegLocations), (rawID, "IMG_1.CR3", rawLocations),
    ] where record.method == "GET" && record.path == "/api/assets/\(id)" {
      let locations = places.map {
        #"{"path":"\#($0)","filename":"\#(name)","library_id":"f1","deleted_at":null}"#
      }
      return respond(
        request,
        json: """
          {"id":"\(id)","folder_id":"f1","filename":"\(name)",
           "abs_path":"\(libPath)/\(places[0])/\(name)",
           "fileinfo":[\(locations.joined(separator: ","))],"size":2,"mtime":0,"rating":0}
          """)
    }
    return nil
  }

  private func noContent(_ request: URLRequest) -> (Data, HTTPURLResponse) {
    let response = HTTPURLResponse(
      url: request.url!, statusCode: 204, httpVersion: "HTTP/1.1", headerFields: nil)!
    return (Data(), response)
  }

  func testTrashGoesRawFirstAndARefusedJpegBringsTheRawBack() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { record, request in
      if let lookup = self.trashLookup(record, request) { return lookup }
      if record.method == "DELETE", record.path.contains(self.jpegID) {
        return self.respond(request, status: 409, json: #"{"error":"state","state":"trashed"}"#)
      }
      if record.path.hasSuffix("/restore") {
        return self.respond(request, json: #"{"abs_path":"/srv/photos/Library/Trip/IMG_1.CR3"}"#)
      }
      return self.noContent(request)
    }

    let result = try await catalog.deleteAsset(
      assetID: rawID, intent: .trash, stack: stack, libraryFolderID: "f1",
      primaryAbsPath: rawAbsPath)

    XCTAssertEqual(result, .stateMismatch(state: "trashed"))
    XCTAssertEqual(
      recorder.requests.filter { $0.method != "GET" }.map { "\($0.method) \($0.path)" },
      [
        "DELETE /api/assets/\(rawID)", "DELETE /api/assets/\(jpegID)",
        "POST /api/assets/\(rawID)/restore",
      ])
  }

  func testARefusedRawLeavesTheJpegUntouched() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { record, request in
      if let lookup = self.trashLookup(record, request) { return lookup }
      return self.respond(request, status: 409, json: #"{"error":"state","state":"purged"}"#)
    }

    let result = try await catalog.deleteAsset(
      assetID: rawID, intent: .trash, stack: stack, libraryFolderID: "f1",
      primaryAbsPath: rawAbsPath)

    XCTAssertEqual(result, .stateMismatch(state: "purged"))
    XCTAssertEqual(
      recorder.requests.filter { $0.method == "DELETE" }.map(\.path), ["/api/assets/\(rawID)"])
  }

  /// The server names each trashed asset on its own: with an older `IMG_1.CR3` in its Trash the
  /// RAW became `IMG_1.1.CR3` while the JPEG landed as `IMG_1.JPG` and published `IMG_1.xmp`
  /// beside the older RAW, both answering success. Such a trash is now refused before anything
  /// moves, until the server trashes a pair under one stem (#5930).
  func testTrashIsRefusedWhenTheServerTrashHoldsAFileOfThePairsStem() async throws {
    for occupant in ["IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp"] {
      let recorder = Recorder()
      let catalog = catalog(recorder) { record, request in
        if let lookup = self.trashLookup(
          record, request, inTrash: [".maple/trash/Trip/\(occupant)"])
        {
          return lookup
        }
        return self.noContent(request)
      }

      do {
        _ = try await catalog.deleteAsset(
          assetID: rawID, intent: .trash, stack: stack, libraryFolderID: "f1",
          primaryAbsPath: rawAbsPath)
        XCTFail("\(occupant) in the server's Trash must refuse the stacked trash")
      } catch FileOperationError.destinationExists(let message) {
        XCTAssertTrue(message.contains(occupant), message)
      }
      XCTAssertEqual(
        recorder.requests.filter { $0.method != "GET" }.map(\.path), [],
        "nothing is trashed when \(occupant) is in the server's Trash")
    }
  }

  /// The server's trash takes no location: for a JPEG it holds in several places it trashes the
  /// copy it picks, which need not be the one beside this RAW, and both DELETEs answered success
  /// while the listed JPEG stayed behind. Such a trash is now refused before anything moves.
  func testTrashIsRefusedWhenTheServerHoldsTheJpegInSeveralPlaces() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { record, request in
      if let lookup = self.trashLookup(record, request, jpegLocations: ["Album", "Trip"]) {
        return lookup
      }
      return self.noContent(request)
    }

    do {
      _ = try await catalog.deleteAsset(
        assetID: rawID, intent: .trash, stack: stack, libraryFolderID: "f1",
        primaryAbsPath: rawAbsPath)
      XCTFail("a JPEG in several places must refuse the stacked trash")
    } catch FileOperationError.unsupportedSource(let message) {
      XCTAssertTrue(message.contains("IMG_1.JPG"), message)
    }
    XCTAssertEqual(
      recorder.requests.filter { $0.method != "GET" }.map(\.path), [], "nothing is trashed")
  }

  /// The same holds for the RAW: with the RAW in several places the server could trash another
  /// copy of it alongside this folder's JPEG, leaving the listed RAW behind.
  func testTrashIsRefusedWhenTheServerHoldsTheRawInSeveralPlaces() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { record, request in
      if let lookup = self.trashLookup(record, request, rawLocations: ["Album", "Trip"]) {
        return lookup
      }
      return self.noContent(request)
    }

    do {
      _ = try await catalog.deleteAsset(
        assetID: rawID, intent: .trash, stack: stack, libraryFolderID: "f1",
        primaryAbsPath: rawAbsPath)
      XCTFail("a RAW in several places must refuse the stacked trash")
    } catch FileOperationError.unsupportedSource(let message) {
      XCTAssertTrue(message.contains("IMG_1.CR3"), message)
    }
    XCTAssertEqual(
      recorder.requests.filter { $0.method != "GET" }.map(\.path), [], "nothing is trashed")
  }
}
