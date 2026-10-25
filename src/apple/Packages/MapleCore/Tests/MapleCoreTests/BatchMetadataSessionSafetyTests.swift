// BatchMetadataSessionSafetyTests — batch metadata never writes default,
// stale or variant develop settings into an asset's Primary sidecar (#4709).
// Every case round-trips a REAL .xmp beside the committed synthetic DNG.

import MapleBackup
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

  func testLiveBatchReportsExternalSidecarConflict() async throws {
    let raw = try makeRaw()
    try await saveSidecar(exposure: 0, stars: 1, title: "Original", beside: raw)
    let session = EditSession(asset: AssetRef(url: raw))
    await session.loadSidecar()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let external = XMPSerializer.serialize(
      model: AdjustmentModel(exposure: 2), culling: CullingState(stars: 3))
    try external.write(to: sidecar, atomically: true, encoding: .utf8)

    do {
      try await rate(4, [session.asset], sessions: [session.asset.id: session])
      XCTFail("The batch must report an externally changed Primary sidecar")
    } catch {
      XCTAssertEqual(failedAssets(error), [session.asset.id])
    }
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), external)
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

  func testPhotoKitBatchWritesBothSidecarsAndPreservesExistingEdits() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "batch-photokit")
    defer { try? FileManager.default.removeItem(at: root) }
    let backing = AppSupportSidecarStore(root: root)
    let ids = ["PHOTO-ONE/L0/001", "PHOTO-TWO/L0/001"]
    let assets = ids.map { id in
      AssetRef(
        displayName: "\(id).dng", hintExtension: "dng", stableID: id,
        thumbnailProvenance: .photoKit, bytesProvider: { Data() })
    }
    for (index, id) in ids.enumerated() {
      var model = AdjustmentModel.default
      model.exposure = Double(index + 1)
      var metadata = XmpMetadata()
      metadata.title = "Original \(index + 1)"
      let store = PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing)
      await store.update(
        model: model, culling: CullingState(stars: index + 1), metadata: metadata)
      await store.flush()
    }

    let vm = BatchMetadataViewModel(
      assets: assets, sessions: [:], photoKitSidecarRoot: root)
    await vm.loadExistingMetadata()
    XCTAssertTrue(vm.mixedFields.contains(.title))
    XCTAssertTrue(vm.mixedFields.contains(.rating))
    var touched = TouchedMetadata()
    touched.instructions = "QA batch metadata"
    vm.touchedMetadata = touched
    try await vm.apply()

    for (index, id) in ids.enumerated() {
      let xml = try XCTUnwrap(backing.read(phassetLocalId: id))
      let (model, culling) = try XMPParser.parse(xml)
      let metadata = XMPParser.parseMetadata(xml)
      XCTAssertEqual(model.exposure, Double(index + 1), accuracy: 1e-9)
      XCTAssertEqual(culling.stars, index + 1)
      XCTAssertEqual(metadata.title, "Original \(index + 1)")
      XCTAssertEqual(metadata.instructions, "QA batch metadata")
    }
  }

  func testPhotoKitBatchRejectsCorruptSidecarWithoutReplacingIt() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "batch-photokit-corrupt")
    defer { try? FileManager.default.removeItem(at: root) }
    let id = "CORRUPT/L0/001"
    let backing = AppSupportSidecarStore(root: root)
    let sidecar = backing.sidecarURL(phassetLocalId: id)
    try Self.unreadableSidecar.write(to: sidecar)
    let asset = AssetRef(
      displayName: "corrupt.dng", hintExtension: "dng", stableID: id,
      thumbnailProvenance: .photoKit, bytesProvider: { Data() })
    let vm = BatchMetadataViewModel(
      assets: [asset], sessions: [:], photoKitSidecarRoot: root)
    vm.touchedMetadata.instructions = "Must not write"

    do {
      try await vm.apply()
      XCTFail("a corrupt PhotoKit sidecar must fail")
    } catch {
      XCTAssertEqual(failedAssets(error), [asset.id])
    }
    XCTAssertEqual(try Data(contentsOf: sidecar), Self.unreadableSidecar)
  }

  func testPhotoKitLiveSessionKeepsBatchRatingOnNextEdit() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "batch-photokit-session")
    defer { try? FileManager.default.removeItem(at: root) }
    let id = "LIVE-PHOTO/L0/001"
    let backing = AppSupportSidecarStore(root: root)
    let asset = AssetRef(
      displayName: "live.dng", hintExtension: "dng", stableID: id,
      thumbnailProvenance: .photoKit, bytesProvider: { Data() })
    let store = PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing)
    let session = EditSession(asset: asset, remoteSidecarStore: store)
    await session.loadSidecar()
    let vm = BatchMetadataViewModel(
      assets: [asset], sessions: [asset.id: session], photoKitSidecarRoot: root)
    vm.touchedMetadata.stars = 4
    vm.touchedMetadata.instructions = "From batch"
    try await vm.apply()
    XCTAssertEqual(session.culling.stars, 4)

    session.beginEdit()
    session.model.contrast = 25
    session.endEdit()
    await session.flushPendingSidecarWrite()

    let xml = try XCTUnwrap(backing.read(phassetLocalId: id))
    let (model, culling) = try XMPParser.parse(xml)
    XCTAssertEqual(model.contrast, 25, accuracy: 1e-9)
    XCTAssertEqual(culling.stars, 4)
    XCTAssertEqual(XMPParser.parseMetadata(xml).instructions, "From batch")
  }

  func testPhotoKitReboundPrimaryKeepsBatchRatingOnNextEdit() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "batch-photokit-rebound")
    defer { try? FileManager.default.removeItem(at: root) }
    let id = "LIVE-PHOTO/L0/002"
    let backing = AppSupportSidecarStore(root: root)
    let asset = AssetRef(
      displayName: "rebound.dng", hintExtension: "dng", stableID: id,
      thumbnailProvenance: .photoKit, bytesProvider: { Data() })
    let store = PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing)
    let session = EditSession(asset: asset, remoteSidecarStore: store)
    await session.workflow.reload(session: session)
    await session.workflow.createVariant(name: "Night", session: session)
    XCTAssertNil(session.workflow.errorText)
    await session.workflow.selectVariant(WorkflowContract.primaryVariantID, session: session)
    XCTAssertNil(session.workflow.errorText)
    XCTAssertTrue(session.sidecarStore is XMPSidecarStore)

    let vm = BatchMetadataViewModel(
      assets: [asset], sessions: [asset.id: session], photoKitSidecarRoot: root)
    vm.touchedMetadata.stars = 4
    try await vm.apply()
    XCTAssertEqual(session.culling.stars, 4)

    session.beginEdit()
    session.model.contrast = 25
    session.endEdit()
    await session.flushPendingSidecarWrite()

    let xml = try XCTUnwrap(backing.read(phassetLocalId: id))
    let (model, culling) = try XMPParser.parse(xml)
    XCTAssertEqual(model.contrast, 25, accuracy: 1e-9)
    XCTAssertEqual(culling.stars, 4)
  }

  func testPhotoKitVariantBatchPreservesLaterPrimaryEdits() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "batch-photokit-primary-refresh")
    defer { try? FileManager.default.removeItem(at: root) }
    let id = "LIVE-PHOTO/L0/003"
    let backing = AppSupportSidecarStore(root: root)
    let asset = AssetRef(
      displayName: "variant.dng", hintExtension: "dng", stableID: id,
      thumbnailProvenance: .photoKit, bytesProvider: { Data() })
    let store = PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing)
    let session = EditSession(asset: asset, remoteSidecarStore: store)
    await session.workflow.reload(session: session)
    await session.workflow.createVariant(name: "Night", session: session)
    XCTAssertNil(session.workflow.errorText)
    let variantID = session.workflow.selectedVariantId
    await session.workflow.selectVariant(WorkflowContract.primaryVariantID, session: session)
    XCTAssertNil(session.workflow.errorText)

    session.beginEdit()
    session.model.contrast = 25
    session.endEdit()
    try await session.setCulling { $0.flag = .pick }
    await session.flushPendingSidecarWrite()
    await session.workflow.selectVariant(variantID, session: session)
    XCTAssertNil(session.workflow.errorText)

    let vm = BatchMetadataViewModel(
      assets: [asset], sessions: [asset.id: session], photoKitSidecarRoot: root)
    vm.touchedMetadata.stars = 4
    try await vm.apply()

    let xml = try XCTUnwrap(backing.read(phassetLocalId: id))
    let (model, culling) = try XMPParser.parse(xml)
    XCTAssertEqual(model.contrast, 25, accuracy: 1e-9)
    XCTAssertEqual(culling.flag, .pick)
    XCTAssertEqual(culling.stars, 4)
    await session.workflow.selectVariant(WorkflowContract.primaryVariantID, session: session)
    XCTAssertNil(session.workflow.errorText)
    XCTAssertEqual(session.culling.stars, 4)
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
