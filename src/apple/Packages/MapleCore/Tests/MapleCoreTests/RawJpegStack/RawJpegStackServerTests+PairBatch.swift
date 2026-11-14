import XCTest

@testable import MapleCore

/// #5929: a server with `stack_pair_ops_supported` renames each stack of a batch as a pair from
/// `companion_ids`, so the client neither asks `file-meta` about JPEG names first nor renames the
/// JPEGs afterwards.
extension RawJpegStackServerTests {
  /// A server whose batch rename previews each ID as `names[id]` and answers `results[id]`.
  private func batchServer(
    _ recorder: Recorder, pairOps: Bool = true, names: [String: String],
    results: [String: String]
  ) -> RemoteCatalog {
    catalog(recorder, pairOps: pairOps) { record, request in
      let ids = record.body["ids"] as? [String] ?? []
      if record.path == "/api/assets/batch-rename/preview" {
        let items = ids.map {
          #"{"id":"\#($0)","new_filename":"\#(names[$0] ?? "")","duplicate":false}"#
        }
        return self.respond(request, json: #"{"items":[\#(items.joined(separator: ","))]}"#)
      }
      if record.path == "/api/assets/batch-rename" {
        let items = ids.compactMap { results[$0] }
        return self.respond(
          request,
          json: """
            {"summary":{"total":\(ids.count),"relocated":0,"skipped":0,"failed":0},
             "results":[\(items.joined(separator: ","))]}
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

  private func cloudAsset(_ name: String, id: String, stack: RawJpegStack? = nil) -> AssetRef {
    AssetRef(
      displayName: name, hintExtension: (name as NSString).pathExtension, stableID: id,
      catalog: CatalogRef(
        serverID: URL(string: "https://example.test")!, folderID: "f1",
        absPath: "\(libPath)/Trip/\(name)", address: "lib:Trip/\(name)"),
      stack: stack, bytesProvider: { Data() })
  }

  @MainActor
  private func applyBatch(
    _ recorder: Recorder, pairOps: Bool = true, stack: RawJpegStack? = nil,
    collision: BatchRenameCollisionChoice = .replace, rawResult: String
  ) async -> [BatchRenameApplyResult] {
    let vm = BatchRenameViewModel(
      assets: [
        cloudAsset("DSC_1.NEF", id: "a1"),
        cloudAsset("IMG_1.CR3", id: rawID, stack: stack ?? self.stack),
      ],
      routing: .cloud,
      cloudCatalog: batchServer(
        recorder, pairOps: pairOps, names: ["a1": "Beach_1.NEF", rawID: "Beach_2.CR3"],
        results: [
          "a1": #"{"id":"a1","kind":"relocated","new_filename":"Beach_1.NEF"}"#,
          rawID: rawResult,
        ]))
    vm.template = "Beach_{n}.{ext}"
    vm.collision = collision
    await vm.apply()
    return vm.applyResults ?? []
  }

  private var renamedPair: String {
    #"{"id":"\#(rawID)","kind":"relocated","new_filename":"Beach_2.CR3","companion_new_filename":"Beach_2.JPG"}"#
  }

  @MainActor
  func testAPairServerBatchSendsEachStacksJpegAndChecksNothingFirst() async throws {
    let recorder = Recorder()

    let results = await applyBatch(recorder, rawResult: renamedPair)

    let batches = recorder.requests.filter { $0.path == "/api/assets/batch-rename" }
    XCTAssertEqual(batches.count, 1, "a Replace batch is no longer split around a stack")
    let body = try XCTUnwrap(batches.first?.body)
    XCTAssertEqual(body["ids"] as? [String], ["a1", rawID])
    let companions = try XCTUnwrap(body["companion_ids"] as? [Any])
    XCTAssertEqual(companions.count, 2)
    XCTAssertTrue(companions[0] is NSNull)
    XCTAssertEqual(companions[1] as? String, jpegID)
    XCTAssertEqual(
      recorder.requests.map(\.path).filter {
        $0.hasPrefix("/api/folders") || $0.hasSuffix("/rename")
      },
      [], "no file-meta lookups and no JPEG rename after the batch")
    XCTAssertEqual(
      results.map(\.outcome),
      [.renamed(newFilename: "Beach_1.NEF"), .renamed(newFilename: "Beach_2.CR3")])
  }

  @MainActor
  func testAPairSkippedOnTheJpegsNewNameIsReportedAsTheJpegs() async {
    let recorder = Recorder()
    let onJpeg = await applyBatch(
      recorder,
      rawResult:
        #"{"id":"\#(rawID)","kind":"skipped","reason":"collision","collision_filename":"Beach_2.JPG"}"#
    )
    let onRaw = await applyBatch(
      Recorder(),
      rawResult:
        #"{"id":"\#(rawID)","kind":"skipped","reason":"collision","collision_filename":"Beach_2.CR3"}"#
    )

    XCTAssertEqual(
      onJpeg.last?.outcome,
      .skipped(reason: "Beach_2.JPG already exists, so this RAW and its JPEG kept their names."))
    XCTAssertEqual(onRaw.last?.outcome, .skipped(reason: "collision"))
    XCTAssertFalse(recorder.requests.contains { $0.path.hasSuffix("/rename") })
  }

  @MainActor
  func testAPairServerBatchLeavesOutAStackWhoseJpegIsNotIndexedYet() async throws {
    let recorder = Recorder()
    let unindexed = RawJpegStack(
      primary: .init(name: "IMG_1.CR3", size: 3), companion: .init(name: "IMG_1.JPG", size: 2),
      location: .cloud(
        address: "lib:Trip/IMG_1.JPG", path: "/srv/photos/Library/Trip/IMG_1.JPG", id: nil))

    let results = await applyBatch(
      recorder, stack: unindexed, collision: .skip, rawResult: renamedPair)

    let batches = recorder.requests.filter { $0.path == "/api/assets/batch-rename" }
    XCTAssertEqual(batches.map { $0.body["ids"] as? [String] ?? [] }, [["a1"]])
    guard case .skipped(let reason) = results.last?.outcome else {
      return XCTFail("expected the stack skipped, got \(String(describing: results.last))")
    }
    XCTAssertTrue(reason.hasSuffix("Both files keep their names."), reason)
  }

  @MainActor
  func testAnOlderServersBatchCarriesNoCompanionsAndRenamesTheJpegAfterwards() async throws {
    let recorder = Recorder()

    let results = await applyBatch(
      recorder, pairOps: false, collision: .skip,
      rawResult: #"{"id":"\#(rawID)","kind":"relocated","new_filename":"Beach_2.CR3"}"#)

    let batch = try XCTUnwrap(recorder.requests.first { $0.path == "/api/assets/batch-rename" })
    XCTAssertNil(batch.body["companion_ids"])
    let jpeg = try XCTUnwrap(recorder.requests.last)
    XCTAssertEqual(jpeg.path, "/api/assets/\(jpegID)/rename")
    XCTAssertEqual(jpeg.body["new_filename"] as? String, "Beach_2.JPG")
    XCTAssertEqual(results.last?.outcome, .renamed(newFilename: "Beach_2.CR3"))
  }

  func testABatchItemCarriesTheJpegsNewNameAndTheTakenName() throws {
    let items = try JSONDecoder().decode(
      [CloudBatchRenameResultItem].self,
      from: Data(
        """
        [{"id":"r1","kind":"relocated","new_filename":"B.CR3","companion_new_filename":"B.JPG"},
         {"id":"r2","kind":"skipped","reason":"collision","collision_filename":"C.JPG"},
         {"id":"r3","kind":"relocated","new_filename":"D.NEF"}]
        """.utf8))

    XCTAssertEqual(items.map(\.companionNewFilename), ["B.JPG", nil, nil])
    XCTAssertEqual(items.map(\.collisionFilename), [nil, "C.JPG", nil])
  }
}
