import CoreGraphics
import CoreImage
import ImageIO
import MapleAgentWire
import XCTest

@testable import MapleCore

@MainActor
final class AgentBrowseTests: XCTestCase {
  private final class MockBrowseDelegate: AgentBrowseDelegate {
    var browseAssets: [AssetRef] = []
    var selectedAssetID: AssetRef.ID?
    var activeCollectionName: String? = "Test Collection"
    var activeFolderPath: String? = "/path/to/photos"
    var sessions: [AssetRef.ID: EditSession] = [:]

    func session(for asset: AssetRef) -> EditSession? {
      sessions[asset.id]
    }

    func ensureSession(for asset: AssetRef) -> EditSession {
      if let existing = sessions[asset.id] { return existing }
      let s = EditSession(asset: asset, model: .default, culling: CullingState())
      sessions[asset.id] = s
      return s
    }

    func openPhoto(assetID: AssetRef.ID) async throws -> EditSession {
      guard let asset = browseAssets.first(where: { $0.id == assetID }) else {
        throw AgentError(
          code: "asset_not_found", message: "No photo found with ID `\(assetID)`.")
      }
      let session = ensureSession(for: asset)
      selectedAssetID = assetID
      return session
    }

    func updateCulling(
      assetID: AssetRef.ID,
      mutate: @Sendable @escaping (inout CullingState) -> Void
    ) async throws -> CullingState {
      guard let asset = browseAssets.first(where: { $0.id == assetID }) else {
        throw AgentError(
          code: "asset_not_found", message: "No photo found with ID `\(assetID)`.")
      }
      let session = ensureSession(for: asset)
      var c = session.culling
      mutate(&c)
      session.culling = c
      return c
    }
  }

  private func makeAsset(name: String) -> AssetRef {
    AssetRef(displayName: name, hintExtension: "dng") { Data() }
  }

  private func call(
    _ service: AgentEditService, _ tool: String, _ arguments: [String: JSONValue] = [:]
  ) async -> Result<AgentPayload, AgentError> {
    await service.handle(AgentRequest(id: 1, tool: tool, arguments: arguments)).outcome
  }

  func testBrowseUnavailableWhenDelegateIsNil() async {
    let service = AgentEditService()
    let outcome = await call(service, "maple_list_photos")
    guard case .failure(let error) = outcome else { return XCTFail("expected failure") }
    XCTAssertEqual(error.code, "browse_unavailable")
  }

  func testListPhotosReturnsPaginatedListAndMetadata() async throws {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    let a1 = makeAsset(name: "photo1.dng")
    let a2 = makeAsset(name: "photo2.dng")
    let a3 = makeAsset(name: "photo3.dng")
    delegate.browseAssets = [a1, a2, a3]

    let s1 = delegate.ensureSession(for: a1)
    s1.culling.stars = 4
    s1.culling.flag = .pick
    s1.culling.colorLabel = .yellow

    service.browseDelegate = delegate
    service.activate(s1)

    let payload = try await call(service, "maple_list_photos", ["offset": 0, "limit": 2]).get()
    let result = payload.result

    XCTAssertEqual(result["total_count"], 3)
    XCTAssertEqual(result["offset"], 0)
    XCTAssertEqual(result["limit"], 2)
    XCTAssertEqual(result["collection_name"], "Test Collection")
    XCTAssertEqual(result["folder_path"], "/path/to/photos")

    guard let photos = result["photos"]?.arrayValue else { return XCTFail("expected photos") }
    XCTAssertEqual(photos.count, 2)
    XCTAssertEqual(photos[0]["id"]?.stringValue, a1.id.uuidString)
    XCTAssertEqual(photos[0]["name"]?.stringValue, "photo1.dng")
    XCTAssertEqual(photos[0]["rating"], 4)
    XCTAssertEqual(photos[0]["flag"], "pick")
    XCTAssertEqual(photos[0]["color_label"], "yellow")
    XCTAssertEqual(photos[0]["is_active"], true)

    XCTAssertEqual(photos[1]["id"]?.stringValue, a2.id.uuidString)
    XCTAssertEqual(photos[1]["rating"], 0)
    XCTAssertEqual(photos[1]["flag"], "none")
    XCTAssertEqual(photos[1]["is_active"], false)
  }

  func testDecodedUnsafeNumbersAreRejectedWithoutMutation() async throws {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    let asset = makeAsset(name: "unchanged.dng")
    delegate.browseAssets = [asset]
    service.browseDelegate = delegate
    let session = delegate.ensureSession(for: asset)
    session.culling.stars = 3
    let cases = [
      ("maple_list_photos", "offset"), ("maple_list_photos", "limit"),
      ("maple_get_thumbnails", "max_edge"), ("maple_set_rating", "rating"),
    ]
    for (tool, key) in cases {
      for invalid in ["1e100", "-1e100", "9223372036854775808", "1.5", "null", "true", "\"5\""] {
        let json = """
          {"id":1,"tool":"\(tool)","arguments":{"asset_id":"\(asset.id.uuidString)",
          "asset_ids":["\(asset.id.uuidString)"],"\(key)":\(invalid)}}
          """
        let request = try XCTUnwrap(AgentRequest(json: JSONValue.decode(Data(json.utf8))))
        guard case .failure(let error) = await service.handle(request).outcome else {
          XCTFail("Accepted \(key)=\(invalid)")
          continue
        }
        XCTAssertEqual(error.code, "invalid_arguments", "\(key)=\(invalid)")
        XCTAssertEqual(session.culling.stars, 3)
      }
    }
  }

  func testRepresentableLargeOffsetReturnsEmptyPageAndDefaultsRemainValid() async throws {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    delegate.browseAssets = [makeAsset(name: "one.dng")]
    service.browseDelegate = delegate
    let large = try await call(service, "maple_list_photos", ["offset": .number(1e18)]).get()
    XCTAssertEqual(large.result["photos"]?.arrayValue?.count, 0)
    let defaults = try await call(service, "maple_list_photos").get()
    XCTAssertEqual(defaults.result["offset"], 0)
    XCTAssertEqual(defaults.result["limit"], 50)
    XCTAssertEqual(defaults.result["photos"]?.arrayValue?.count, 1)
  }

  func testSocketCullingPersistsRealSidecarAndRejectsUnsafeRating() async throws {
    var fixture = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { fixture.deleteLastPathComponent() }
    fixture.append(path: "MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
    let dir = try SidecarContractIO.makeTempDirectory(prefix: "agent-browse")
    defer { try? FileManager.default.removeItem(at: dir) }
    let raw = dir.appendingPathComponent("grey.dng")
    try FileManager.default.copyItem(at: fixture, to: raw)
    let original = try Data(contentsOf: raw)
    let asset = AssetRef(url: raw)
    let session = EditSession(asset: asset, model: .default, culling: CullingState())
    let browse = BrowseViewModel()
    browse.assets = [asset]
    let adapter = AppShellBrowseAdapter(
      browseVM: browse, getSessions: { [asset.id: session] }, ensureSessionHandler: { _ in session }
    )
    let service = AgentEditService()
    service.browseDelegate = adapter
    service.activate(session)
    let controller = AgentBridgeController(service: service)
    let socket = "/tmp/browse-\(UUID().uuidString.prefix(8)).sock"
    controller.start(path: socket)
    defer { controller.stop() }
    XCTAssertTrue(controller.isListening, controller.lastError ?? "")
    let client = AgentSocketClient(path: socket, timeout: 10)
    let rated = try await Task.detached {
      try client.send(
        AgentRequest(
          id: 1, tool: "maple_set_rating",
          arguments: [
            "asset_id": .string(asset.id.uuidString), "rating": 4,
          ]))
    }.value.outcome.get()
    XCTAssertEqual(rated.result["rating"], 4)
    let rejectedRating = try await Task.detached {
      try client.send(
        AgentRequest(
          id: 2, tool: "maple_set_rating",
          arguments: [
            "asset_id": .string(asset.id.uuidString), "rating": .number(1e100),
          ]))
    }.value.outcome
    guard case .failure(let error) = rejectedRating else { return XCTFail("expected rejection") }
    XCTAssertEqual(error.code, "invalid_arguments")
    let reopened = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
    await reopened.loadSidecar()
    XCTAssertEqual(reopened.culling.stars, 4)
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testListPhotosOffsetAndLimitValidation() async {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    service.browseDelegate = delegate

    let negOffset = await call(service, "maple_list_photos", ["offset": -1])
    guard case .failure(let e1) = negOffset else { return XCTFail("expected failure") }
    XCTAssertEqual(e1.code, "invalid_arguments")

    let zeroLimit = await call(service, "maple_list_photos", ["limit": 0])
    guard case .failure(let e2) = zeroLimit else { return XCTFail("expected failure") }
    XCTAssertEqual(e2.code, "invalid_arguments")

    let excessiveLimit = await call(service, "maple_list_photos", ["limit": 101])
    guard case .failure(let e3) = excessiveLimit else { return XCTFail("expected failure") }
    XCTAssertEqual(e3.code, "invalid_arguments")
  }

  func testSetRatingValidatesAndPersists() async throws {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    let a1 = makeAsset(name: "photo1.dng")
    delegate.browseAssets = [a1]
    service.browseDelegate = delegate

    // Out of range: -1
    let belowZero = await call(
      service, "maple_set_rating",
      ["asset_id": .string(a1.id.uuidString), "rating": -1])
    guard case .failure(let e1) = belowZero else { return XCTFail("expected failure") }
    XCTAssertEqual(e1.code, "invalid_arguments")

    // Out of range: 6
    let aboveFive = await call(
      service, "maple_set_rating",
      ["asset_id": .string(a1.id.uuidString), "rating": 6])
    guard case .failure(let e2) = aboveFive else { return XCTFail("expected failure") }
    XCTAssertEqual(e2.code, "invalid_arguments")

    // Unknown asset
    let unknownAsset = await call(
      service, "maple_set_rating",
      ["asset_id": .string(UUID().uuidString), "rating": 5])
    guard case .failure(let e3) = unknownAsset else { return XCTFail("expected failure") }
    XCTAssertEqual(e3.code, "asset_not_found")

    // Valid: 5 stars
    let success = try await call(
      service, "maple_set_rating",
      ["asset_id": .string(a1.id.uuidString), "rating": 5]
    ).get()

    XCTAssertEqual(success.result["asset_id"]?.stringValue, a1.id.uuidString)
    XCTAssertEqual(success.result["rating"], 5)
    XCTAssertEqual(delegate.sessions[a1.id]?.culling.stars, 5)
  }

  func testSetFlagValidatesAndPersists() async throws {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    let a1 = makeAsset(name: "photo1.dng")
    delegate.browseAssets = [a1]
    service.browseDelegate = delegate

    // Invalid flag value
    let invalidFlag = await call(
      service, "maple_set_flag",
      ["asset_id": .string(a1.id.uuidString), "flag": "invalid_flag"])
    guard case .failure(let e1) = invalidFlag else { return XCTFail("expected failure") }
    XCTAssertEqual(e1.code, "invalid_arguments")

    // Valid: pick
    let success = try await call(
      service, "maple_set_flag",
      ["asset_id": .string(a1.id.uuidString), "flag": "pick"]
    ).get()

    XCTAssertEqual(success.result["flag"], "pick")
    XCTAssertEqual(delegate.sessions[a1.id]?.culling.flag, .pick)

    // Valid: reject
    let reject = try await call(
      service, "maple_set_flag",
      ["asset_id": .string(a1.id.uuidString), "flag": "reject"]
    ).get()
    XCTAssertEqual(reject.result["flag"], "reject")
    XCTAssertEqual(delegate.sessions[a1.id]?.culling.flag, .reject)
  }

  func testOpenPhotoSwitchesActivePhotoAndReturnsFullState() async throws {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    let a1 = makeAsset(name: "photo1.dng")
    let a2 = makeAsset(name: "photo2.dng")
    delegate.browseAssets = [a1, a2]
    service.browseDelegate = delegate

    // Unknown asset
    let unknown = await call(
      service, "maple_open_photo",
      ["asset_id": .string(UUID().uuidString)])
    guard case .failure(let e) = unknown else { return XCTFail("expected failure") }
    XCTAssertEqual(e.code, "asset_not_found")

    // Open photo2
    let payload = try await call(
      service, "maple_open_photo",
      ["asset_id": .string(a2.id.uuidString)]
    ).get()

    let result = payload.result
    XCTAssertEqual(result["photo_id"]?.stringValue, a2.id.uuidString)
    XCTAssertEqual(result["file_name"], "photo2.dng")
    XCTAssertNotNil(result["revision"])
    XCTAssertNotNil(result["adjustments"])
    XCTAssertEqual(delegate.selectedAssetID, a2.id)

    // Verify active photo is now a2
    let active = try await call(service, "maple_get_active_photo").get().result
    XCTAssertEqual(active["photo_id"]?.stringValue, a2.id.uuidString)
  }

  func testGetThumbnailsValidatesArgumentsAndBatchLimit() async {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    service.browseDelegate = delegate

    // Empty array
    let empty = await call(service, "maple_get_thumbnails", ["asset_ids": .array([])])
    guard case .failure(let e1) = empty else { return XCTFail("expected failure") }
    XCTAssertEqual(e1.code, "invalid_arguments")

    // > 20 batch limit
    let over20 = (0..<21).map { _ in JSONValue.string(UUID().uuidString) }
    let batchTooLarge = await call(service, "maple_get_thumbnails", ["asset_ids": .array(over20)])
    guard case .failure(let e2) = batchTooLarge else { return XCTFail("expected failure") }
    XCTAssertEqual(e2.code, "invalid_arguments")

    // Invalid max_edge
    let badEdge = await call(
      service, "maple_get_thumbnails",
      ["asset_ids": .array([.string(UUID().uuidString)]), "max_edge": 100])
    guard case .failure(let e3) = badEdge else { return XCTFail("expected failure") }
    XCTAssertEqual(e3.code, "invalid_arguments")
  }
}
