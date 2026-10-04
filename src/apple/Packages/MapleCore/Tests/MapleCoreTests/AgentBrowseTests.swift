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
    var updateCullingCallCount = 0

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
      updateCullingCallCount += 1
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

  private func makeSampleJPEGData() -> Data {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGImageAlphaInfo.noneSkipLast.rawValue
    guard
      let context = CGContext(
        data: nil, width: 64, height: 64, bitsPerComponent: 8,
        bytesPerRow: 64 * 4, space: colorSpace, bitmapInfo: bitmapInfo),
      let cgImage = context.makeImage()
    else { return Data() }
    let data = NSMutableData()
    guard
      let dest = CGImageDestinationCreateWithData(
        data as CFMutableData, "public.jpeg" as CFString, 1, nil)
    else { return Data() }
    CGImageDestinationAddImage(dest, cgImage, nil)
    CGImageDestinationFinalize(dest)
    return data as Data
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
    XCTAssertEqual(photos[1]["is_active"], false)
  }

  func testListPhotosValidatesArguments() async {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    service.browseDelegate = delegate

    let negOffset = await call(service, "maple_list_photos", ["offset": -1])
    guard case .failure(let e1) = negOffset else { return XCTFail("expected failure") }
    XCTAssertEqual(e1.code, "invalid_arguments")

    let zeroLimit = await call(service, "maple_list_photos", ["limit": 0])
    guard case .failure(let e2) = zeroLimit else { return XCTFail("expected failure") }
    XCTAssertEqual(e2.code, "invalid_arguments")

    let bigLimit = await call(service, "maple_list_photos", ["limit": 101])
    guard case .failure(let e3) = bigLimit else { return XCTFail("expected failure") }
    XCTAssertEqual(e3.code, "invalid_arguments")
  }

  func testSetRatingValidatesAndEarlyOutsOnUnchanged() async throws {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    let a1 = makeAsset(name: "photo1.dng")
    delegate.browseAssets = [a1]
    service.browseDelegate = delegate

    // Invalid rating
    let negRating = await call(
      service, "maple_set_rating",
      ["asset_id": .string(a1.id.uuidString), "rating": -1])
    guard case .failure(let e1) = negRating else { return XCTFail("expected failure") }
    XCTAssertEqual(e1.code, "invalid_arguments")

    // Unknown asset
    let unknownAsset = await call(
      service, "maple_set_rating",
      ["asset_id": .string(UUID().uuidString), "rating": 5])
    guard case .failure(let e2) = unknownAsset else { return XCTFail("expected failure") }
    XCTAssertEqual(e2.code, "asset_not_found")

    // Valid: 5 stars
    let success = try await call(
      service, "maple_set_rating",
      ["asset_id": .string(a1.id.uuidString), "rating": 5]
    ).get()
    XCTAssertEqual(success.result["rating"], 5)
    XCTAssertEqual(delegate.sessions[a1.id]?.culling.stars, 5)
    XCTAssertEqual(delegate.updateCullingCallCount, 1)

    // Calling again with 5 stars early-outs without invoking updateCulling
    let noOp = try await call(
      service, "maple_set_rating",
      ["asset_id": .string(a1.id.uuidString), "rating": 5]
    ).get()
    XCTAssertEqual(noOp.result["rating"], 5)
    XCTAssertEqual(delegate.updateCullingCallCount, 1, "no-op rating must early out")
  }

  func testSetFlagValidatesAndEarlyOutsOnUnchanged() async throws {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    let a1 = makeAsset(name: "photo1.dng")
    delegate.browseAssets = [a1]
    service.browseDelegate = delegate

    // Invalid flag
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
    XCTAssertEqual(delegate.updateCullingCallCount, 1)

    // Calling again with pick early-outs
    let noOp = try await call(
      service, "maple_set_flag",
      ["asset_id": .string(a1.id.uuidString), "flag": "pick"]
    ).get()
    XCTAssertEqual(noOp.result["flag"], "pick")
    XCTAssertEqual(delegate.updateCullingCallCount, 1, "no-op flag must early out")
  }

  func testOpenPhotoSwitchesActivePhotoAndReturnsFullState() async throws {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    let a1 = makeAsset(name: "photo1.dng")
    let a2 = makeAsset(name: "photo2.dng")
    delegate.browseAssets = [a1, a2]
    service.browseDelegate = delegate

    let unknown = await call(
      service, "maple_open_photo",
      ["asset_id": .string(UUID().uuidString)])
    guard case .failure(let e) = unknown else { return XCTFail("expected failure") }
    XCTAssertEqual(e.code, "asset_not_found")

    let payload = try await call(
      service, "maple_open_photo",
      ["asset_id": .string(a2.id.uuidString)]
    ).get()
    let result = payload.result
    XCTAssertEqual(result["photo_id"]?.stringValue, a2.id.uuidString)
    XCTAssertEqual(result["file_name"], "photo2.dng")
    XCTAssertNotNil(result["revision"])
    XCTAssertEqual(delegate.selectedAssetID, a2.id)

    let active = try await call(service, "maple_get_active_photo").get().result
    XCTAssertEqual(active["photo_id"]?.stringValue, a2.id.uuidString)
    XCTAssertTrue(service.activeSession === delegate.sessions[a2.id])
  }

  func testGetThumbnailsHappyPathAndPartialErrors() async throws {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    let jpeg = makeSampleJPEGData()
    let a1 = AssetRef(displayName: "valid.jpg", hintExtension: "jpg") { jpeg }
    delegate.browseAssets = [a1]
    service.browseDelegate = delegate

    let missingID = UUID().uuidString
    let payload = try await call(
      service, "maple_get_thumbnails",
      [
        "asset_ids": .array([.string(a1.id.uuidString), .string(missingID)]),
        "max_edge": 512,
      ]
    ).get()

    XCTAssertEqual(payload.images.count, 1)
    guard let src = CGImageSourceCreateWithData(payload.images[0].data as CFData, nil) else {
      return XCTFail("thumbnail JPEG data could not be parsed")
    }
    XCTAssertEqual(CGImageSourceGetCount(src), 1)

    let thumbs = try XCTUnwrap(payload.result["thumbnails"]?.arrayValue)
    XCTAssertEqual(thumbs.count, 2)
    XCTAssertEqual(thumbs[0]["status"], "ok")
    XCTAssertEqual(thumbs[0]["asset_id"]?.stringValue, a1.id.uuidString)
    XCTAssertEqual(thumbs[1]["status"], "error")
    XCTAssertEqual(thumbs[1]["asset_id"]?.stringValue, missingID)
  }

  func testGetThumbnailsValidatesArgumentsAndBatchLimit() async {
    let service = AgentEditService()
    let delegate = MockBrowseDelegate()
    service.browseDelegate = delegate

    let empty = await call(service, "maple_get_thumbnails", ["asset_ids": .array([])])
    guard case .failure(let e1) = empty else { return XCTFail("expected failure") }
    XCTAssertEqual(e1.code, "invalid_arguments")

    let over20 = (0..<21).map { _ in JSONValue.string(UUID().uuidString) }
    let batchTooLarge = await call(service, "maple_get_thumbnails", ["asset_ids": .array(over20)])
    guard case .failure(let e2) = batchTooLarge else { return XCTFail("expected failure") }
    XCTAssertEqual(e2.code, "invalid_arguments")
  }

  func testSetRatingAndFlagRoundTripToRealDiskXMP() async throws {
    let dir = try SidecarContractIO.makeTempDirectory(prefix: "browse-real-xmp")
    let raw = dir.appendingPathComponent("image.png")
    try SidecarContractIO.makeSyntheticOriginal(at: raw)

    let asset = AssetRef(url: raw)
    let adapter = AppShellBrowseAdapter()
    var sessions: [AssetRef.ID: EditSession] = [:]

    let realSession = EditSession(asset: asset, model: .default, culling: CullingState())
    sessions[asset.id] = realSession

    let vm = BrowseViewModel()
    vm.assets = [asset]
    adapter.browseVM = vm
    adapter.getSessions = { sessions }
    adapter.ensureSessionHandler = { a in sessions[a.id] ?? realSession }

    let service = AgentEditService()
    service.browseDelegate = adapter

    let rateResult = try await call(
      service, "maple_set_rating",
      ["asset_id": .string(asset.id.uuidString), "rating": 4]
    ).get()
    XCTAssertEqual(rateResult.result["rating"], 4)

    let flagResult = try await call(
      service, "maple_set_flag",
      ["asset_id": .string(asset.id.uuidString), "flag": "pick"]
    ).get()
    XCTAssertEqual(flagResult.result["flag"], "pick")

    await realSession.flushPendingSidecarWrite()

    let sidecarURL = SidecarPath.sidecarURL(for: raw)
    XCTAssertTrue(FileManager.default.fileExists(atPath: sidecarURL.path))

    let reopened = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
    await reopened.loadSidecar()
    XCTAssertEqual(reopened.culling.stars, 4)
    XCTAssertEqual(reopened.culling.flag, .pick)
  }
}
