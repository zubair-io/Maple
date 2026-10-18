// BatchMetadataSessionSafetyTests — batch metadata never writes default,
// stale or variant develop settings into an asset's Primary sidecar (#4709).
// Every case round-trips a REAL .xmp beside the committed synthetic DNG.

import XCTest

@testable import MapleCore

@MainActor
final class BatchMetadataSessionSafetyTests: EditorTestCase {
  private static let syntheticDNG: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
  }()

  private static let unreadableSidecar = Data([0xFF, 0xFE, 0xFD, 0x00, 0xC3])

  private func makeRaw() throws -> URL {
    let dir = try SidecarContractIO.makeTempDirectory(prefix: "batch-meta-safety")
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    let raw = dir.appendingPathComponent("grey.dng")
    try FileManager.default.copyItem(at: Self.syntheticDNG, to: raw)
    return raw
  }

  private func saveSidecar(exposure: Double, stars: Int, title: String, beside raw: URL)
    async throws
  {
    var model = AdjustmentModel.default
    model.exposure = exposure
    var metadata = XmpMetadata()
    metadata.title = title
    let store = XMPSidecarStore(rawURL: raw)
    await store.update(model: model, culling: CullingState(stars: stars), metadata: metadata)
    await store.flush()
  }

  private func reparse(_ raw: URL) throws -> (AdjustmentModel, CullingState, XmpMetadata) {
    let xml = try String(contentsOf: SidecarPath.sidecarURL(for: raw), encoding: .utf8)
    let (model, culling) = try XMPParser.parse(xml)
    return (model, culling, XMPParser.parseMetadata(xml))
  }

  private func rate(_ stars: Int, _ assets: [AssetRef], sessions: [AssetRef.ID: EditSession])
    async throws
  {
    let vm = BatchMetadataViewModel(assets: assets, sessions: sessions)
    vm.touchedMetadata.stars = stars
    try await vm.apply()
  }

  private func failedAssets(_ error: Error) -> [AssetRef.ID] {
    guard case BatchMetadataViewModel.ApplyError.partialFailure(let failures) = error else {
      return []
    }
    return failures.map(\.0.id)
  }

  func testUnloadedSessionHydratesBeforeTheBatchWrite() async throws {
    let raw = try makeRaw()
    try await saveSidecar(exposure: 1.5, stars: 1, title: "Kept", beside: raw)
    let session = EditSession(asset: AssetRef(url: raw))

    try await rate(4, [session.asset], sessions: [session.asset.id: session])

    let (model, culling, metadata) = try reparse(raw)
    XCTAssertEqual(model.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(culling.stars, 4)
    XCTAssertEqual(metadata.title, "Kept")
    XCTAssertEqual(session.model.exposure, 1.5, accuracy: 1e-9)
  }

  func testLiveSessionAdoptsBatchCullingSoTheNextEditKeepsIt() async throws {
    let raw = try makeRaw()
    try await saveSidecar(exposure: 1.5, stars: 1, title: "Kept", beside: raw)
    let session = EditSession(asset: AssetRef(url: raw))
    await session.loadSidecar()

    try await rate(4, [session.asset], sessions: [session.asset.id: session])
    XCTAssertEqual(session.culling.stars, 4)
    session.beginEdit()
    session.model.contrast = 25
    session.endEdit()
    await session.flushPendingSidecarWrite()

    let (model, culling, metadata) = try reparse(raw)
    XCTAssertEqual(model.contrast, 25, accuracy: 1e-9)
    XCTAssertEqual(culling.stars, 4)
    XCTAssertEqual(metadata.title, "Kept")
  }

  func testUnreadableSidecarWithoutASessionIsAFailureNotADefaultsWrite() async throws {
    let raw = try makeRaw()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try Self.unreadableSidecar.write(to: sidecar)
    let asset = AssetRef(url: raw)

    do {
      try await rate(4, [asset], sessions: [:])
      XCTFail("an unreadable sidecar must be reported, not rewritten")
    } catch {
      XCTAssertEqual(failedAssets(error), [asset.id])
    }
    XCTAssertEqual(try Data(contentsOf: sidecar), Self.unreadableSidecar)
  }

  func testUnreadableSidecarWithASessionIsAFailureNotADefaultsWrite() async throws {
    let raw = try makeRaw()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try Self.unreadableSidecar.write(to: sidecar)
    let session = EditSession(asset: AssetRef(url: raw))

    do {
      try await rate(4, [session.asset], sessions: [session.asset.id: session])
      XCTFail("an unreadable sidecar must be reported, not rewritten")
    } catch {
      XCTAssertEqual(failedAssets(error), [session.asset.id])
    }
    XCTAssertEqual(try Data(contentsOf: sidecar), Self.unreadableSidecar)
  }

  func testVariantSessionNeverCopiesItsModelIntoThePrimarySidecar() async throws {
    let raw = try makeRaw()
    try await saveSidecar(exposure: 1.5, stars: 1, title: "Kept", beside: raw)
    let session = EditSession(asset: AssetRef(url: raw))
    await session.workflow.reload(session: session)
    await session.workflow.createVariant(name: "Night", session: session)
    XCTAssertNil(session.workflow.errorText)
    XCTAssertNotEqual(session.workflow.selectedVariantId, WorkflowContract.primaryVariantID)
    session.beginEdit()
    session.model.exposure = -2
    session.endEdit()
    await session.flushPendingSidecarWrite()
    let variantSidecar = try XCTUnwrap(session.asset.sidecarURL)
    let variantBytes = try Data(contentsOf: variantSidecar)

    try await rate(4, [session.asset], sessions: [session.asset.id: session])

    let (model, culling, metadata) = try reparse(raw)
    XCTAssertEqual(model.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(culling.stars, 4)
    XCTAssertEqual(metadata.title, "Kept")
    XCTAssertEqual(try Data(contentsOf: variantSidecar), variantBytes)
    XCTAssertEqual(session.model.exposure, -2, accuracy: 1e-9)
  }

  func testRemoteAssetIsReportedInsteadOfSilentlySkipped() async throws {
    let remote = AssetRef(
      displayName: "remote.dng", hintExtension: "dng", stableID: "remote-1",
      bytesProvider: { Data() })

    do {
      try await rate(3, [remote], sessions: [:])
      XCTFail("a remote asset the batch cannot write must be reported")
    } catch {
      XCTAssertEqual(failedAssets(error), [remote.id])
    }
  }

  /// A culling change that lands while the batch waits on the session's
  /// pending save must survive the batch's write, not be replaced by the
  /// culling the batch captured before it waited.
  func testCullingEditDuringBatchApplyIsKept() async throws {
    let raw = try makeRaw()
    try await saveSidecar(exposure: 1.5, stars: 1, title: "Kept", beside: raw)
    let session = EditSession(asset: AssetRef(url: raw))
    await session.loadSidecar()
    let store = try XCTUnwrap(session.sidecarStore as? XMPSidecarStore)
    let entered = expectation(description: "sidecar actor occupied")
    let release = DispatchSemaphore(value: 0)
    defer { release.signal() }
    let occupied = Task.detached { await store.occupy(entered: entered, release: release) }
    await fulfillment(of: [entered], timeout: 5)
    session.culling.colorLabel = .red
    let vm = BatchMetadataViewModel(assets: [session.asset], sessions: [session.asset.id: session])
    vm.touchedMetadata.stars = 4

    let batch = Task { try await vm.apply() }
    for _ in 0..<20 { await Task.yield() }
    session.culling.flag = .pick
    release.signal()
    await occupied.value
    try await batch.value

    let (_, culling, metadata) = try reparse(raw)
    XCTAssertEqual(culling.stars, 4)
    XCTAssertEqual(culling.flag, .pick, "the concurrent flag was dropped by the batch write")
    XCTAssertEqual(culling.colorLabel, .red)
    XCTAssertEqual(metadata.title, "Kept")
  }
}

extension XMPSidecarStore {
  /// Holds the store's actor so a queued update cannot run until released.
  fileprivate func occupy(entered: XCTestExpectation, release: DispatchSemaphore) {
    entered.fulfill()
    XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
  }
}
