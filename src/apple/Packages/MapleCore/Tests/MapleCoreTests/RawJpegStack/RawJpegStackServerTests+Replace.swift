import XCTest

@testable import MapleCore

/// #5050 review: Replace chosen for the JPEG's name on a server stack move sends the file there to
/// the server's Trash before the RAW moves, so the server's sidecar ownership check sees the RAW as
/// the only file at the destination stem.
extension RawJpegStackServerTests {
  /// Replace chosen for both names of an unindexed destination pair with a sidecar of its own used
  /// to fail on the RAW: the destination JPEG still shared that sidecar's stem, so the server
  /// refused to replace it (`relocate-sidecar-plan.ts`), though the JPEG's own prompt had chosen to
  /// displace that JPEG. The JPEG now goes to the server's Trash first, then the pair moves.
  func testReplacingTheJpegTrashesItBeforeTheRawReplacesTheSharedSidecar() async throws {
    let recorder = Recorder()
    var occupied: Set<String> = ["Album/IMG_1.CR3", "Album/IMG_1.JPG", "Album/IMG_1.xmp"]
    let catalog = catalog(recorder) { record, request in
      if record.path == "/api/folders/f1/file-meta" {
        return self.fileMeta(request, taken: occupied)
      }
      if record.method == "DELETE", record.path == "/api/folders/f1/file" {
        occupied.remove("Album/IMG_1.JPG")
        return self.respond(request, json: #"{"ok":true}"#)
      }
      // The server's ownership check: a same-stem file left at the destination keeps its sidecar.
      if record.path.contains(self.rawID), occupied.contains("Album/IMG_1.JPG") {
        return self.respond(
          request, status: 500, json: #"{"error":"publish collision: Album/IMG_1.xmp"}"#)
      }
      return self.moved(
        request, path: "Album",
        filename: record.path.contains(self.rawID) ? "IMG_1.CR3" : "IMG_1.JPG")
    }

    let result = try await catalog.relocateAsset(
      assetID: rawID, mode: .move, collision: .replace, destinationPath: "Album",
      sourceAddress: "lib:Trip/IMG_1.CR3", stack: stack, libraryFolderID: "f1",
      restore: ("Trip", "IMG_1.CR3"), companionCollision: .replace)

    guard case .ok = result else { return XCTFail("expected a move, got \(result)") }
    let writes = recorder.requests.filter { $0.method != "GET" }
    XCTAssertEqual(
      writes.map { "\($0.method) \($0.path)" },
      [
        "DELETE /api/folders/f1/file", "POST /api/assets/\(rawID)/relocate",
        "POST /api/assets/\(jpegID)/relocate",
      ])
    XCTAssertEqual(writes[0].query, "path=Album/IMG_1.JPG")
  }

  /// An indexed photo at the JPEG's name is its own asset: trashing it would trash every copy, so
  /// the stack move is refused before anything moves.
  func testAnIndexedPhotoAtTheJpegsNameStopsAReplaceBeforeAnythingMoves() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { record, request in
      if record.path == "/api/folders/f1/file-meta" {
        return self.fileMeta(request, taken: ["Album/IMG_1.JPG"])
      }
      if record.method == "DELETE" {
        return self.respond(
          request, status: 409,
          json: #"{"error":"path is an indexed asset","asset_id":"650a1b2c3d4e5f6071829399"}"#)
      }
      return self.moved(request, path: "Album", filename: "IMG_1.CR3")
    }

    do {
      _ = try await catalog.relocateAsset(
        assetID: rawID, mode: .move, collision: .replace, destinationPath: "Album",
        sourceAddress: "lib:Trip/IMG_1.CR3", stack: stack, libraryFolderID: "f1",
        restore: ("Trip", "IMG_1.CR3"), companionCollision: .replace)
      XCTFail("an indexed photo holds the JPEG's name")
    } catch FileOperationError.invalidDestination(let message) {
      XCTAssertTrue(message.hasPrefix("IMG_1.JPG"), message)
    }
    XCTAssertEqual(recorder.requests.filter { $0.path.hasSuffix("/relocate") }.count, 0)
  }

  /// The JPEG's own name in its own folder is not a file to displace.
  func testReplacingInTheJpegsOwnFolderNeverTrashesTheJpeg() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { record, request in
      if record.path == "/api/folders/f1/file-meta" {
        return self.fileMeta(request, taken: ["Trip/IMG_1.JPG"])
      }
      return self.moved(
        request, path: "Trip",
        filename: record.path.contains(self.rawID) ? "IMG_1.CR3" : "IMG_1.JPG")
    }

    _ = try await catalog.relocateAsset(
      assetID: rawID, mode: .move, collision: .replace, destinationPath: "Trip",
      sourceAddress: "lib:Trip/IMG_1.CR3", stack: stack, libraryFolderID: "f1",
      restore: ("Trip", "IMG_1.CR3"), companionCollision: .replace)

    XCTAssertFalse(recorder.requests.contains { $0.method == "DELETE" })
  }
}
