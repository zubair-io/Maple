import XCTest

@testable import MapleCore

/// #5050 review: nothing a server stack's Replace displaces is lost while the pair cannot land.
extension RawJpegStackServerTests {
  /// A server whose batch rename renames each ID to `names[id]`.
  private func batchCatalog(
    _ recorder: Recorder, names: [String: String], folders: Set<String> = []
  ) -> RemoteCatalog {
    catalog(recorder) { record, request in
      if record.path == "/api/folders" {
        return self.respond(
          request, json: #"[{"id":"f1","path":"\#(self.libPath)","label":"L","file_count":2}]"#)
      }
      if record.path == "/api/folders/f1/file-meta" {
        return self.fileMeta(request, taken: [], folders: folders)
      }
      let ids = record.body["ids"] as? [String] ?? []
      if record.path == "/api/assets/batch-rename/preview" {
        let items = ids.map {
          #"{"id":"\#($0)","new_filename":"\#(names[$0] ?? "")","duplicate":false}"#
        }
        return self.respond(request, json: #"{"items":[\#(items.joined(separator: ","))]}"#)
      }
      if record.path == "/api/assets/batch-rename" {
        let results = ids.map {
          #"{"id":"\#($0)","kind":"relocated","new_filename":"\#(names[$0] ?? "")"}"#
        }
        return self.respond(
          request,
          json: """
            {"summary":{"total":\(ids.count),"relocated":\(ids.count),"skipped":0,"failed":0},
             "results":[\(results.joined(separator: ","))]}
            """)
      }
      let filename = record.body["new_filename"] as? String ?? ""
      return self.respond(
        request,
        json: """
          {"new_abs_path":"/srv/photos/Library/Trip/\(filename)","new_path":"Trip",
           "new_filename":"\(filename)","renamed_on_collision":false,"extension_changed":false}
          """)
    }
  }

  private func asset(
    _ name: String, id: String, stack: RawJpegStack? = nil, address: Bool = true
  ) -> AssetRef {
    AssetRef(
      displayName: name, hintExtension: (name as NSString).pathExtension, stableID: id,
      catalog: CatalogRef(
        serverID: URL(string: "https://example.test")!, folderID: "f1",
        absPath: "\(libPath)/Trip/\(name)", address: address ? "lib:Trip/\(name)" : nil),
      stack: stack, bytesProvider: { Data() })
  }

  /// A Replace batch let the server replace an unindexed file at the RAW's new name, then met a
  /// folder at the JPEG's: the RAW went back under its old name, but the file it had replaced was
  /// gone. A stack whose JPEG cannot follow now stays out of the batch, and the items around it
  /// keep the numbers the preview showed.
  @MainActor
  func testAReplaceBatchLeavesOutAStackWhoseJpegCannotFollow() async throws {
    let recorder = Recorder()
    let vm = BatchRenameViewModel(
      assets: [
        asset("DSC_1.NEF", id: "a1"), asset("IMG_1.CR3", id: rawID, stack: stack),
        asset("DSC_3.NEF", id: "c1"),
      ],
      routing: .cloud,
      cloudCatalog: batchCatalog(
        recorder, names: ["a1": "Beach_1.NEF", rawID: "Beach_2.CR3", "c1": "Beach_3.NEF"],
        folders: ["Trip/Beach_2.JPG"]))
    vm.template = "Beach_{n}.{ext}"
    vm.collision = .replace

    await vm.apply()

    let batches = recorder.requests.filter { $0.path == "/api/assets/batch-rename" }
    XCTAssertEqual(batches.map { $0.body["ids"] as? [String] ?? [] }, [["a1"], ["c1"]])
    XCTAssertEqual(batches.map { $0.body["sequence_start"] as? Int }, [1, 3])
    XCTAssertFalse(recorder.requests.contains { $0.path.hasSuffix("/rename") })
    let results = try XCTUnwrap(vm.applyResults)
    XCTAssertEqual(results[0].outcome, .renamed(newFilename: "Beach_1.NEF"))
    XCTAssertEqual(
      results[1].outcome,
      .skipped(reason: "Beach_2.JPG already exists, so this RAW and its JPEG kept their names."))
    XCTAssertEqual(results[2].outcome, .renamed(newFilename: "Beach_3.NEF"))
  }

  /// Another item of the same Replace batch taking the JPEG's new name keeps the stack out too.
  @MainActor
  func testAReplaceBatchLeavesOutAStackWhoseJpegNameAnotherItemTakes() async throws {
    let recorder = Recorder()
    let vm = BatchRenameViewModel(
      assets: [asset("IMG_1.CR3", id: rawID, stack: stack), asset("DSC_3.JPG", id: "c1")],
      routing: .cloud,
      cloudCatalog: batchCatalog(recorder, names: [rawID: "Beach_2.CR3", "c1": "Beach_2.JPG"]))
    vm.template = "Beach_{n}.{ext}"
    vm.collision = .replace

    await vm.apply()

    let batches = recorder.requests.filter { $0.path == "/api/assets/batch-rename" }
    XCTAssertEqual(batches.map { $0.body["ids"] as? [String] ?? [] }, [["c1"]])
    guard case .skipped = try XCTUnwrap(vm.applyResults).first?.outcome else {
      return XCTFail("expected the stack skipped, got \(String(describing: vm.applyResults))")
    }
  }

  /// Replace chosen for the JPEG's name trashed the file there before the RAW's own name was
  /// looked at; skipping the RAW's prompt that followed, or choosing Keep Both, left that file in
  /// the server's Trash with nothing in its place. A RAW name another file holds now comes back as
  /// skipped before anything goes to the Trash.
  func testATakenRawNameIsAskedAboutBeforeTheJpegsOccupantGoesToTheTrash() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { record, request in
      if record.path == "/api/folders/f1/file-meta" {
        return self.fileMeta(request, taken: ["Album/IMG_1.CR3", "Album/IMG_1.JPG"])
      }
      return self.moved(request, path: "Album", filename: "IMG_1.CR3")
    }

    let result = try await catalog.relocateAsset(
      assetID: rawID, mode: .move, collision: .fail, destinationPath: "Album",
      sourceAddress: "lib:Trip/IMG_1.CR3", stack: stack, libraryFolderID: "f1",
      restore: ("Trip", "IMG_1.CR3"), companionCollision: .replace)

    XCTAssertEqual(result, .skipped(reason: "collision"))
    XCTAssertEqual(recorder.requests.filter { $0.method != "GET" }.map(\.path), [])
  }

  /// A RAW the server refuses after the JPEG's occupant went to the Trash used to come back as a
  /// plain refusal: the error now says where that file is, since the server cannot put back a file
  /// it does not index.
  func testARawRefusedAfterTheJpegsOccupantWasTrashedSaysWhereThatFileIs() async throws {
    let recorder = Recorder()
    let catalog = catalog(recorder) { record, request in
      if record.path == "/api/folders/f1/file-meta" {
        return self.fileMeta(request, taken: ["Album/IMG_1.JPG"])
      }
      if record.method == "DELETE" { return self.respond(request, status: 204, json: "") }
      return self.respond(request, status: 400, json: #"{"error":"bad destination"}"#)
    }

    do {
      _ = try await catalog.relocateAsset(
        assetID: rawID, mode: .move, collision: .replace, destinationPath: "Album",
        sourceAddress: "lib:Trip/IMG_1.CR3", stack: stack, libraryFolderID: "f1",
        restore: ("Trip", "IMG_1.CR3"), companionCollision: .replace)
      XCTFail("the RAW was refused")
    } catch FileOperationError.underlying(let message) {
      XCTAssertTrue(message.contains("bad destination"), message)
      XCTAssertTrue(message.contains("IMG_1.JPG had already gone to the server's Trash"), message)
    }
    XCTAssertEqual(recorder.requests.filter { $0.method == "DELETE" }.count, 1)
  }

  /// A Timeline hit's JPEG carries no address: its new name is looked up beside the RAW.
  @MainActor
  func testAReplaceBatchLooksUpAnUnaddressedJpegsNewNameBesideTheRaw() async throws {
    let recorder = Recorder()
    let unaddressed = RawJpegStack(
      primary: .init(name: "IMG_1.CR3", size: 3), companion: .init(name: "IMG_1.JPG", size: 2),
      location: .cloud(address: nil, path: "/srv/photos/Library/Trip/IMG_1.JPG", id: jpegID))
    let vm = BatchRenameViewModel(
      assets: [asset("IMG_1.CR3", id: rawID, stack: unaddressed)], routing: .cloud,
      cloudCatalog: batchCatalog(
        recorder, names: [rawID: "Beach_2.CR3"], folders: ["Trip/Beach_2.JPG"]))
    vm.template = "Beach_{n}.{ext}"
    vm.collision = .replace

    await vm.apply()

    XCTAssertFalse(recorder.requests.contains { $0.path == "/api/assets/batch-rename" })
    XCTAssertEqual(
      try XCTUnwrap(vm.applyResults).first?.outcome,
      .skipped(reason: "Beach_2.JPG already exists, so this RAW and its JPEG kept their names."))
  }

  /// A hit from a library with no registered slug carries no address for the RAW or the JPEG
  /// (`routes/search/project.ts`): a Replace batch skipped every such stack, even with the JPEG's
  /// new name free. The JPEG's folder now comes from its server path under the library's root.
  @MainActor
  func testAReplaceBatchRenamesASluglessStackWhoseJpegNameIsFree() async throws {
    let recorder = Recorder()
    let slugless = RawJpegStack(
      primary: .init(name: "IMG_1.CR3", size: 3), companion: .init(name: "IMG_1.JPG", size: 2),
      location: .cloud(address: nil, path: "\(libPath)/Trip/IMG_1.JPG", id: jpegID))
    let vm = BatchRenameViewModel(
      assets: [asset("IMG_1.CR3", id: rawID, stack: slugless, address: false)], routing: .cloud,
      cloudCatalog: batchCatalog(recorder, names: [rawID: "Beach_2.CR3"]))
    vm.template = "Beach_{n}.{ext}"
    vm.collision = .replace

    await vm.apply()

    let lookups = recorder.requests.filter { $0.path == "/api/folders/f1/file-meta" }
    XCTAssertEqual(lookups.map(\.query), ["path=Trip/Beach_2.JPG"])
    let batches = recorder.requests.filter { $0.path == "/api/assets/batch-rename" }
    XCTAssertEqual(batches.map { $0.body["ids"] as? [String] ?? [] }, [[rawID]])
    XCTAssertTrue(recorder.requests.contains { $0.path == "/api/assets/\(jpegID)/rename" })
    XCTAssertEqual(
      try XCTUnwrap(vm.applyResults).first?.outcome, .renamed(newFilename: "Beach_2.CR3"))
  }
}
