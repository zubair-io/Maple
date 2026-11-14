import CoreImage
import Foundation
import XCTest

@testable import MapleCore

/// #4669 review: a name-only `crs:WhiteBalance="Auto"` through the editor's real
/// triggers. The editor opening runs one estimate after the first frame; no final
/// output (thumbnail, preview, Copy, export) takes the As Shot frame; the pair
/// never becomes an undo step and stays on every model that replaces `model`.
@MainActor
final class ImportedAutoWhiteBalanceSessionTests: XCTestCase {
  private let nameOnly = """
    <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Auto"/></rdf:RDF></x:xmpmeta>
    """

  /// Holds the background estimate open until the test releases it.
  private actor EstimateGate {
    private var released = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private(set) var entered = 0

    func pass() async {
      entered += 1
      guard !released else { return }
      await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
      released = true
      for waiter in waiters { waiter.resume() }
      waiters.removeAll()
    }
  }

  private struct EstimateFailed: Error {}

  // MARK: - The editor opening

  func testEditorOpenEstimatesOncePerOpenedPhotoAfterTheFirstFrame() async throws {
    let (session, raw) = try await openEditor("imported-auto-open")
    try await waitUntil("the pair") {
      if session.isResolvingFirstFrame {
        XCTAssertEqual(self.ffiCalls(raw), 0, "The first frame never waits for the estimate")
      }
      return session.importedAuto.target != nil
    }
    XCTAssertEqual(ffiCalls(raw), 1)
    let target = try await estimatorPair(beside: raw)
    XCTAssertEqual(session.importedAuto.target, target)
    XCTAssertEqual(session.model.temperature, target.temperature, "Sliders show the pair")
    XCTAssertEqual(session.model.tint, target.tint)
    XCTAssertEqual(session.renderModel, session.model)
    XCTAssertTrue(session.undoHistory.isEmpty)

    // Re-showing the editor, a re-decoded frame and an export reuse the pair.
    session.ensureRenderStarted()
    session.adoptDecodedWbFrame(session.wbSliderFrame)
    try await settle(session)
    _ = try await session.renderForExport(sizeOption: .fast)
    XCTAssertEqual(ffiCalls(raw), 1)
    await session.flushPendingSidecarWrite()
    try assertNameOnly(raw)

    // Opening the photo again is a new session: exactly one more estimate.
    let reopened = EditSession(asset: AssetRef(url: raw))
    await reopened.loadSidecar()
    reopened.previewSize = CGSize(width: 96, height: 64)
    reopened.ensureRenderStarted()
    try await waitUntil("the reopened pair") { reopened.importedAuto.target != nil }
    XCTAssertEqual(reopened.importedAuto.target, target)
    XCTAssertEqual(ffiCalls(raw), 2)
    await reopened.renderActor.cancelAll()
  }

  // MARK: - Final outputs

  func testAsShotFirstFrameIsNeverPersistedAndExitPersistsThePair() async throws {
    let gate = EstimateGate()
    let (session, raw) = try await openEditor("imported-auto-thumb", estimate: gated(gate))
    try await waitUntil("the estimate to start") { await gate.entered == 1 }
    try await settle(session)
    XCTAssertNotNil(session.renderedPreview, "The As Shot first frame is on screen")
    XCTAssertFalse(session.previewPersistence.hasPendingImage, "No As Shot display preview")
    XCTAssertFalse(session.persistCurrentPreviewToCache(), "No As Shot rendered-preview cache")
    let canPublish = await session.canPublishDerivedPixels()
    XCTAssertFalse(canPublish)
    let asShotThumbnail = await ThumbnailDiskCache.shared.thumbnail(for: raw)
    XCTAssertNil(asShotThumbnail, "No As Shot browse thumbnail")
    let asShotCache = await cachedPreview(raw)
    XCTAssertNil(asShotCache)

    // Leaving the editor while the estimate runs waits for the pair first.
    let exit = Task { await session.persistDisplayPreviewOnExit() }
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertFalse(FileManager.default.fileExists(atPath: previewURL(raw).path))
    await gate.release()
    await exit.value
    XCTAssertNotNil(session.importedAuto.target)
    XCTAssertTrue(FileManager.default.fileExists(atPath: previewURL(raw).path))
    let thumbnail = await ThumbnailDiskCache.shared.thumbnail(for: raw)
    XCTAssertNotNil(thumbnail)
    try await waitUntil("the rendered-preview cache") { await self.cachedPreview(raw) != nil }
    XCTAssertEqual(ffiCalls(raw), 1)
    try assertNameOnly(raw)
  }

  func testFailedEstimatePersistsNoAsShotOutput() async throws {
    let (session, raw) = try await openEditor(
      "imported-auto-failed", estimate: { _, _, _ in throw EstimateFailed() })
    try await waitUntil("the estimate to start") { session.importedAuto.request != nil }
    await session.importedAuto.request?.value
    try await settle(session)
    XCTAssertNil(session.importedAuto.target)
    XCTAssertTrue(session.model.awaitsImportedAutoPair)
    XCTAssertNil(session.renderError, "As Shot stays on screen without an error")
    await session.persistDisplayPreviewOnExit()
    XCTAssertFalse(FileManager.default.fileExists(atPath: previewURL(raw).path))
    let thumbnail = await ThumbnailDiskCache.shared.thumbnail(for: raw)
    XCTAssertNil(thumbnail)
    let cached = await cachedPreview(raw)
    XCTAssertNil(cached)
  }

  func testCopyAndExportDuringTheEstimateJoinItWithoutASecondEstimate() async throws {
    let gate = EstimateGate()
    let (session, raw) = try await openEditor("imported-auto-copy", estimate: gated(gate))
    try await waitUntil("the estimate to start") { await gate.entered == 1 }
    let asShot = session.model.temperature
    let library = liveLibrary(session, raw)
    let copy = Task { try await library.readModel(for: AssetRef(url: raw)) }
    let export = Task { try await session.renderForExport(sizeOption: .fast) }
    try await Task.sleep(for: .milliseconds(200))
    await gate.release()
    let copied = try await copy.value
    _ = try await export.value
    let target = try XCTUnwrap(session.importedAuto.target)
    XCTAssertNotEqual(asShot, target.temperature)
    XCTAssertEqual(copied.temperature, target.temperature, "Copy never authors As Shot")
    XCTAssertEqual(copied.tint, target.tint)
    XCTAssertEqual(copied.partialWhiteBalance?.resolvedTarget, target)
    XCTAssertEqual(ffiCalls(raw), 1, "Copy and export join the session's estimate")
  }

  func testCopyBeforeTheFirstFrameStartsTheSessionEstimateOnce() async throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "imported-auto-copy-early")
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("source.dng")
    try FileManager.default.copyItem(
      at: try PartialWhiteBalanceFixture.root().appendingPathComponent("source.dng"), to: raw)
    try nameOnly.write(to: SidecarPath.sidecarURL(for: raw), atomically: true, encoding: .utf8)
    let session = EditSession(asset: AssetRef(url: raw))
    await session.loadSidecar()
    let copied = try await liveLibrary(session, raw).readModel(for: AssetRef(url: raw))
    let target = try XCTUnwrap(session.importedAuto.target)
    XCTAssertEqual(copied.partialWhiteBalance?.resolvedTarget, target)
    XCTAssertEqual(ffiCalls(raw), 1)
  }

  func testCopyAfterAFailedEstimateResolvesInsteadOfAuthoringAsShot() async throws {
    let (session, raw) = try await openEditor(
      "imported-auto-copy-failed", estimate: { _, _, _ in throw EstimateFailed() })
    try await waitUntil("the estimate to start") { session.importedAuto.request != nil }
    await session.importedAuto.request?.value
    XCTAssertTrue(session.model.awaitsImportedAutoPair)
    let copied = try await liveLibrary(session, raw).readModel(for: AssetRef(url: raw))
    let target = try await estimatorPair(beside: raw)
    XCTAssertEqual(copied.temperature, target.temperature)
    XCTAssertEqual(copied.tint, target.tint)
  }

  func testNonRawNameOnlyAutoResolvesAtOpenSoItsOutputsAreNotHeldBack() async throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "imported-auto-png")
    defer { try? FileManager.default.removeItem(at: directory) }
    let png = directory.appendingPathComponent("original.png")
    _ = try SidecarContractIO.makeSyntheticOriginal(at: png)
    try nameOnly.write(to: SidecarPath.sidecarURL(for: png), atomically: true, encoding: .utf8)
    let session = EditSession(asset: AssetRef(url: png))
    await session.loadSidecar()
    XCTAssertNil(session.partialWhiteBalanceImportError)
    XCTAssertFalse(session.model.awaitsImportedAutoPair, "No estimator runs for a non-RAW")
    XCTAssertNotNil(session.model.partialWhiteBalance?.resolvedTarget)
    session.resolveImportedAutoWhiteBalance()
    XCTAssertNil(session.importedAuto.request)
    let canPublish = await session.canPublishDerivedPixels()
    XCTAssertTrue(canPublish)
  }

  // MARK: - Undo and later edits

  func testEstimateLandingInsideAGestureIsNotAnUndoStep() async throws {
    let gate = EstimateGate()
    let (session, _) = try await openEditor("imported-auto-gesture", estimate: gated(gate))
    try await waitUntil("the estimate to start") { await gate.entered == 1 }
    session.beginEdit(description: "Exposure")
    await gate.release()
    try await waitUntil("the pair") { session.importedAuto.target != nil }
    session.endEdit()
    XCTAssertTrue(session.undoHistory.isEmpty)
    XCTAssertFalse(session.canUndo)
    XCTAssertNil(session.lastCommittedTransaction)
  }

  func testModelsThatReplaceTheModelKeepThePair() async throws {
    let gate = EstimateGate()
    let (session, raw) = try await openEditor("imported-auto-undo", estimate: gated(gate))
    try await waitUntil("the estimate to start") { await gate.entered == 1 }
    let exposure = session.model.exposure
    session.beginEdit(description: "Exposure")
    session.model.exposure = exposure + 0.5
    session.endEdit()
    await gate.release()
    try await waitUntil("the pair") { session.importedAuto.target != nil }
    let target = try XCTUnwrap(session.importedAuto.target)

    session.undo()
    XCTAssertEqual(session.model.exposure, exposure)
    assertShowsPair(session, target)
    session.redo()
    XCTAssertEqual(session.model.exposure, exposure + 0.5)
    assertShowsPair(session, target)
    let restored = try await session.workflow.restoredState(nameOnly, session: session)
    session.applyConfirmedWorkflowState(restored)
    assertShowsPair(session, target)
    // A variant switch takes the pair on its reset and compare baseline too.
    let variant = try await session.workflow.restoredState(nameOnly, session: session)
    session.applyWorkflowVariant(variant)
    assertShowsPair(session, target)
    XCTAssertEqual(session.originalModel, session.model, "Switching variants is not an edit")
    await session.flushPendingSidecarWrite()
    try assertNameOnly(raw)
  }

  func testVariantSwitchWaitsForAutoWithoutTreatingHydrationAsAnEdit() async throws {
    let gate = EstimateGate()
    let (session, raw) = try await openEditor("imported-auto-variant", estimate: gated(gate))
    try await waitUntil("the estimate to start") { await gate.entered == 1 }
    let id = UUID().uuidString.lowercased()
    let primary = SidecarPath.sidecarURL(for: raw)
    let sibling = raw.deletingLastPathComponent().appendingPathComponent(
      try WorkflowSidecarCore.variantFilename(
        primaryName: primary.lastPathComponent, variantId: id))
    var variant = try XMPParser.parse(nameOnly).0
    variant.exposure = 1.25
    let xml = try WorkflowSidecarCore.embed(
      SidecarWorkflow(
        schemaVersion: WorkflowContract.version, variantId: id, variantName: "Night",
        snapshots: [], history: []),
      in: XMPSerializer.serialize(model: variant, culling: CullingState()))
    try xml.write(to: sibling, atomically: true, encoding: .utf8)
    await session.workflow.reload(session: session)
    let selection = Task { await session.workflow.selectVariant(id, session: session) }
    try await waitUntil("variant persistence to join the estimate") {
      session.workflow.previews.captureXML != nil
    }
    XCTAssertEqual(session.workflow.selectedVariantId, WorkflowContract.primaryVariantID)
    await gate.release()
    await selection.value
    XCTAssertNil(session.workflow.errorText)
    XCTAssertEqual(session.workflow.selectedVariantId, id)
    XCTAssertEqual(session.asset.selectedSidecarURL, sibling)
    XCTAssertEqual(session.model.exposure, 1.25)
    assertShowsPair(session, try XCTUnwrap(session.importedAuto.target))
    XCTAssertTrue(session.undoHistory.isEmpty)
    XCTAssertEqual(try String(contentsOf: sibling, encoding: .utf8), xml)
    try assertNameOnly(raw)
  }

  func testLateEstimateAfterANumericWhiteBalanceEditKeepsTheEdit() async throws {
    let gate = EstimateGate()
    let (session, raw) = try await openEditor("imported-auto-late", estimate: gated(gate))
    try await waitUntil("the estimate to start") { await gate.entered == 1 }
    session.beginEdit(description: "White balance")
    ToolValueMapping.apply(5300, to: &session.model, tool: .temp)
    session.endEdit()
    let edited = session.model
    await gate.release()
    await session.importedAuto.request?.value
    XCTAssertEqual(session.model, edited)
    XCTAssertNil(session.model.partialWhiteBalance)
    XCTAssertEqual(session.renderModel, session.model)
    XCTAssertEqual(session.undoHistory.count, 1)
    await session.flushPendingSidecarWrite()
    XCTAssertTrue(try activeXmp(raw).contains("crs:Temperature="))
    // Undoing the edit brings back the name-only intent, now with its pair.
    session.undo()
    assertShowsPair(session, try XCTUnwrap(session.importedAuto.target))
  }

  /// A 100% patch that finished before the pair landed stayed on screen in As
  /// Shot over the newly balanced base: adoption hydrates (skipping `model`'s
  /// own clear) and the refine keeps a patch that covers the viewport.
  func testThePairLandingDropsANativeDetailPatchDevelopedBeforeIt() async throws {
    let gate = EstimateGate()
    let (session, _) = try await openEditor("imported-auto-detail", estimate: gated(gate))
    try await waitUntil("the estimate to start") { await gate.entered == 1 }
    try await settle(session)
    session.nativeDetailPreview = CIImage(color: .red)
      .cropped(to: CGRect(x: 0, y: 0, width: 4, height: 4))
    session.nativeDetailSourceRect = CGRect(x: 0, y: 0, width: 64, height: 64)
    let request = session.nativeDetailRequestID
    await gate.release()
    try await waitUntil("the pair") { session.importedAuto.target != nil }
    XCTAssertNil(session.nativeDetailPreview, "An As Shot patch never covers the pair")
    XCTAssertEqual(session.nativeDetailSourceRect, .zero)
    XCTAssertNotEqual(session.nativeDetailRequestID, request, "In-flight detail is stale")
  }

  // MARK: - Closing

  func testClosingTheEditorCancelsItsEstimate() async throws {
    let gate = EstimateGate()
    var (session, raw): (EditSession?, URL) = try await openEditor(
      "imported-auto-close", estimate: gated(gate))
    try await waitUntil("the estimate to start") { await gate.entered == 1 }
    let request = try XCTUnwrap(session?.importedAuto.request)
    try await settle(try XCTUnwrap(session))
    await session?.renderActor.cancelAll()
    weak var closed = session
    session = nil
    try await waitUntil("the session to close") { closed == nil }
    await gate.release()
    await request.value
    XCTAssertEqual(ffiCalls(raw), 0, "A closed editor's estimate never reaches the FFI")
  }

  // MARK: - Helpers

  private func openEditor(
    _ prefix: String, estimate: ImportedAutoWhiteBalance.Estimate? = nil
  ) async throws -> (EditSession, URL) {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: prefix)
    let raw = directory.appendingPathComponent("source.dng")
    try FileManager.default.copyItem(
      at: try PartialWhiteBalanceFixture.root().appendingPathComponent("source.dng"), to: raw)
    try nameOnly.write(to: SidecarPath.sidecarURL(for: raw), atomically: true, encoding: .utf8)
    await RenderedPreviewCache.shared.configure(folderURL: directory)
    await ThumbnailDiskCache.shared.configure(folderURL: directory)
    let session = EditSession(asset: AssetRef(url: raw))
    if let estimate { session.importedAuto.estimate = estimate }
    addTeardownBlock { [weak session] in
      await session?.flushPendingSidecarWrite()
      await session?.renderActor.cancelAll()
      try? FileManager.default.removeItem(at: directory)
    }
    await session.loadSidecar()
    XCTAssertTrue(session.model.awaitsImportedAutoPair)
    session.previewSize = CGSize(width: 96, height: 64)
    session.ensureRenderStarted()
    return (session, raw)
  }

  private func gated(_ gate: EstimateGate) -> ImportedAutoWhiteBalance.Estimate {
    { asset, model, sessionRaw in
      await gate.pass()
      return try await ImportedWhiteBalanceResolver.resolve(
        asset: asset, model: model, sessionRaw: sessionRaw)
    }
  }

  private func liveLibrary(_ session: EditSession, _ raw: URL) -> BatchAdjustmentLibrary {
    BatchAdjustmentLibrary(
      id: "test", resolve: { _ in AssetRef(url: raw) }, session: { _ in session },
      store: { _ in XMPSidecarStore(rawURL: raw) })
  }

  /// The estimator's pair from a copy of the RAW, so the session's own file
  /// keeps an exact FFI count.
  private func estimatorPair(beside raw: URL) async throws -> ResolvedWhiteBalance {
    let reference = raw.deletingLastPathComponent().appendingPathComponent("reference.dng")
    if !FileManager.default.fileExists(atPath: reference.path) {
      try FileManager.default.copyItem(at: raw, to: reference)
    }
    let resolved = try await ImportedWhiteBalanceResolver.resolve(
      asset: AssetRef(url: reference), model: XMPParser.parse(nameOnly).0)
    return try XCTUnwrap(resolved.partialWhiteBalance?.resolvedTarget)
  }

  private func ffiCalls(_ raw: URL) -> Int {
    ImportedWhiteBalanceResolver.ffiCalls.withLock { $0[raw.path] ?? 0 }
  }

  private func settle(_ session: EditSession) async throws {
    for _ in 0..<2 {
      _ = await session.latestRenderSchedule?.value
      await session.renderActor.awaitCurrentRenderIfInFlight()
      // The refine pass runs after a 150 ms debounce.
      try await Task.sleep(for: .milliseconds(400))
    }
    await session.renderActor.awaitCurrentRenderIfInFlight()
  }

  private func waitUntil(
    _ what: String, timeout: Duration = .seconds(30), _ condition: () async -> Bool
  ) async throws {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while await !condition() {
      guard ContinuousClock.now < deadline else {
        XCTFail("Timed out waiting for \(what)")
        return
      }
      try await Task.sleep(for: .milliseconds(20))
    }
  }

  private func cachedPreview(_ raw: URL) async -> CIImage? {
    let cache = RenderedPreviewCache()
    await cache.configure(folderURL: raw.deletingLastPathComponent())
    return await cache.preview(for: raw, screenWidth: 96)
  }

  private func previewURL(_ raw: URL) -> URL { MapleSidecarPaths.previewURL(for: raw) }

  private func activeXmp(_ raw: URL) throws -> String {
    try WorkflowSidecarCore.checkpoint(
      xmp: String(contentsOf: SidecarPath.sidecarURL(for: raw), encoding: .utf8))
  }

  private func assertNameOnly(
    _ raw: URL, file: StaticString = #filePath, line: UInt = #line
  ) throws {
    let saved = try activeXmp(raw)
    XCTAssertTrue(saved.contains(#"crs:WhiteBalance="Auto""#), file: file, line: line)
    XCTAssertFalse(saved.contains("crs:Temperature="), file: file, line: line)
    XCTAssertFalse(saved.contains("crs:Tint="), file: file, line: line)
  }

  private func assertShowsPair(
    _ session: EditSession, _ target: ResolvedWhiteBalance,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertEqual(session.model.temperature, target.temperature, file: file, line: line)
    XCTAssertEqual(session.model.tint, target.tint, file: file, line: line)
    XCTAssertEqual(session.model, session.renderModel, file: file, line: line)
    XCTAssertFalse(session.model.awaitsImportedAutoPair, file: file, line: line)
  }
}
