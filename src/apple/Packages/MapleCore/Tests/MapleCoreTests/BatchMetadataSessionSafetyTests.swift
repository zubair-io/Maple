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
}
