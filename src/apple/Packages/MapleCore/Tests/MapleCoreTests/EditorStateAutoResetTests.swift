// EditorStateAutoResetTests.swift — AUTO (#1379) and RESET (#1372) tests.
//
// Pure code-move from EditorStateTests.swift to clear the 600-LOC file budget.
// All tests are MainActor — EditorState + EditSession are MainActor-isolated.

import XCTest

@testable import MapleCore

@MainActor
final class EditorStateAutoResetTests: XCTestCase {

  // MARK: - Helpers

  private func makeSession() -> EditSession {
    EditSession.preview()
  }

  /// A file-backed session for injected analysis results.
  private func makeFileBackedSession() -> EditSession {
    EditSession(
      asset: AssetRef(url: URL(fileURLWithPath: "/tmp/maple-auto-test.dng")),
      model: .default,
      culling: CullingState()
    )
  }

  // MARK: - Reset to factory defaults (#1372)

  func testResetToFactoryDefaultsRestoresDefaultsWithAsShotWBAndAutoProfile() {
    let session = makeSession()
    let state = EditorState(session: session)
    session.asShotCCT = 5200
    session.asShotTint = 7

    var dirty = session.model
    dirty.exposure = 2
    dirty.contrast = 40
    dirty.saturation = -30
    dirty.profile = .neutral
    dirty.temperature = 9000
    dirty.crop = Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 5)
    session.model = dirty
    let preservedCrop = session.model.crop

    state.resetToFactoryDefaults()

    let m = state.session.model
    // Develop sliders back to factory defaults.
    XCTAssertEqual(m.exposure, AdjustmentModel.default.exposure, accuracy: 1e-9)
    XCTAssertEqual(m.contrast, AdjustmentModel.default.contrast, accuracy: 1e-9)
    XCTAssertEqual(m.saturation, AdjustmentModel.default.saturation, accuracy: 1e-9)
    // White balance → camera As-Shot; profile → Auto.
    XCTAssertEqual(m.temperature, 5200, accuracy: 1e-9)
    XCTAssertEqual(m.tint, 7, accuracy: 1e-9)
    XCTAssertEqual(m.profile, .auto)
    // Crop / rotation preserved.
    XCTAssertEqual(m.crop, preservedCrop)
    XCTAssertEqual(m.crop.angle, 5, accuracy: 1e-9)
    // One undo entry restores the full pre-reset model.
    XCTAssertTrue(state.canUndo)
    state.undo()
    XCTAssertEqual(state.session.model.exposure, 2, accuracy: 1e-9)
    XCTAssertEqual(state.session.model.profile, .neutral)
  }

  func testResetToFactoryDefaultsFallsBackToNeutralWBWithoutAsShot() {
    let session = makeSession()
    let state = EditorState(session: session)
    session.asShotCCT = nil
    session.asShotTint = nil
    var dirty = session.model
    dirty.temperature = 9000
    dirty.tint = 30
    session.model = dirty

    state.resetToFactoryDefaults()

    let m = state.session.model
    XCTAssertEqual(m.temperature, 6500, accuracy: 1e-9)
    XCTAssertEqual(m.tint, 0, accuracy: 1e-9)
    XCTAssertEqual(m.profile, .auto)
  }

  /// #2244 — pins the difference between RESET and "revert to the model as
  /// it was at session open". The editor's Reset control used to call the
  /// latter (`EditSession.resetToOriginal()`); on an image that already
  /// carried sidecar edits when the session opened, that silently restored
  /// those edits instead of clearing them. The two agree only on a
  /// pristine image, which is why the divergence went unnoticed.
  func testResetToFactoryDefaultsIgnoresPreExistingSidecarEdits() {
    // A session OPENED on an already-edited image: `originalModel` — the
    // snapshot `resetToOriginal()` restores — is itself non-default.
    var onDisk = AdjustmentModel.default
    onDisk.exposure = -1.5
    onDisk.contrast = 25
    onDisk.saturation = 60
    let session = EditSession(
      asset: AssetRef(url: URL(fileURLWithPath: "/tmp/maple-reset-test.dng")),
      model: onDisk,
      culling: CullingState()
    )
    let state = EditorState(session: session)
    XCTAssertEqual(
      session.originalModel.exposure, -1.5, accuracy: 1e-9,
      "precondition: the session-open snapshot carries edits")

    state.resetToFactoryDefaults()

    let m = state.session.model
    XCTAssertEqual(m.exposure, AdjustmentModel.default.exposure, accuracy: 1e-9)
    XCTAssertEqual(m.contrast, AdjustmentModel.default.contrast, accuracy: 1e-9)
    XCTAssertEqual(m.saturation, AdjustmentModel.default.saturation, accuracy: 1e-9)
    XCTAssertNotEqual(
      m.exposure, session.originalModel.exposure,
      "RESET must reach factory defaults, not the session-open snapshot")

    // And the weaker action really would have kept them — the divergence
    // this test exists to pin.
    session.resetToOriginal()
    XCTAssertEqual(state.session.model.exposure, -1.5, accuracy: 1e-9)
    XCTAssertEqual(state.session.model.saturation, 60, accuracy: 1e-9)
  }

  // MARK: - AUTO (#1379)

  func testAutoDoesNotOverwriteAnEditMadeDuringAnalysis() async {
    await assertStaleAutoIsDiscarded(undoInterveningEdit: false)
  }

  func testAutoDoesNotApplyAfterAnInterveningEditIsUndone() async {
    await assertStaleAutoIsDiscarded(undoInterveningEdit: true)
  }

  private func assertStaleAutoIsDiscarded(undoInterveningEdit: Bool) async {
    let session = makeFileBackedSession()
    let state = EditorState(session: session)
    let started = expectation(description: "AUTO analysis started")
    let gate = AutoAnalysisGate()
    state.autoProvider = { _ in
      started.fulfill()
      await gate.wait()
      return AutoAdjustmentsResult(
        exposure: 1.2, temperature: 5200, tint: 8,
        contrast: 12, highlights: -18, shadows: 22, whites: -6, blacks: -9
      )
    }
    let task = Task { @MainActor in await state.applyAuto() }
    await fulfillment(of: [started], timeout: 5)
    XCTAssertTrue(state.autoInProgress)

    state.commit(description: "Manual exposure")
    session.model.exposure = -1.5
    session.endEdit()
    if undoInterveningEdit { state.undo() }
    let expected = session.model
    let history = session.undoHistory
    let canRedo = state.canRedo

    await gate.open()
    await task.value

    XCTAssertEqual(
      session.model, expected, "A slow AUTO result must preserve the newer user intent.")
    XCTAssertEqual(session.undoHistory, history, "Discarding AUTO must not create an undo entry.")
    XCTAssertEqual(state.canRedo, canRedo, "Discarding AUTO must preserve the user's redo history.")
    XCTAssertFalse(state.autoInProgress)
  }

  func testUnchangedAutoPreservesRedoHistory() async {
    let session = makeFileBackedSession()
    let state = EditorState(session: session)
    state.autoProvider = { _ in
      AutoAdjustmentsResult(
        exposure: 1.2, temperature: 5200, tint: 8,
        contrast: 12, highlights: -18, shadows: 22, whites: -6, blacks: -9
      )
    }
    await state.applyAuto()
    let autoModel = session.model
    state.commit(description: "Manual exposure")
    session.model.exposure = -1.5
    session.endEdit()
    state.undo()
    XCTAssertTrue(state.canRedo)

    await state.applyAuto()

    XCTAssertEqual(session.model, autoModel)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertTrue(state.canRedo, "An unchanged AUTO recommendation must not discard redo.")
    state.redo()
    XCTAssertEqual(session.model.exposure, -1.5)
  }

  func testFailedAutoLeavesModelAndHistoryUntouched() async {
    struct AnalysisFailure: Error {}
    let session = makeFileBackedSession()
    let state = EditorState(session: session)
    let before = session.model
    state.autoProvider = { _ in throw AnalysisFailure() }

    await state.applyAuto()

    XCTAssertEqual(session.model, before)
    XCTAssertFalse(state.canUndo)
    XCTAssertFalse(state.autoInProgress)
  }

  func testCancelledAutoDoesNotCommitAfterLeavingEditor() async {
    let session = makeFileBackedSession()
    let state = EditorState(session: session)
    let before = session.model
    state.autoProvider = { _ in
      AutoAdjustmentsResult(
        exposure: 1.2, temperature: 5200, tint: 8,
        contrast: 12, highlights: -18, shadows: 22, whites: -6, blacks: -9
      )
    }
    let task = Task { @MainActor in await state.applyAuto() }
    task.cancel()
    await task.value

    XCTAssertEqual(session.model, before)
    XCTAssertFalse(state.canUndo)
    XCTAssertFalse(state.autoInProgress)
  }

  /// #2255 — #1376's calibrated tone sliders must land in the model
  /// byte-identically to how a user drag would (so undo / sidecar write /
  /// render invalidation all see them), including the corrected white balance estimate.
  func testApplyAutoAppliesExposureToneAndWhiteBalance() async {
    let session = makeFileBackedSession()
    let state = EditorState(session: session)
    state.autoProvider = { _ in
      AutoAdjustmentsResult(
        exposure: 1.2, temperature: 5200, tint: 8,
        contrast: 12, highlights: -18, shadows: 22, whites: -6, blacks: -9
      )
    }
    // Pre-set WB + tone to prove both recommendations replace the previous values.
    var dirty = session.model
    dirty.contrast = 40
    dirty.temperature = 7000
    dirty.tint = 12
    session.model = dirty

    await state.applyAuto()

    let after = state.session.model
    // The core's calibrated recommendation (#1376) lands exactly.
    XCTAssertEqual(after.exposure, 1.2, accuracy: 1e-9)
    XCTAssertEqual(after.contrast, 12, accuracy: 1e-9)
    XCTAssertEqual(after.highlights, -18, accuracy: 1e-9)
    XCTAssertEqual(after.shadows, 22, accuracy: 1e-9)
    XCTAssertEqual(after.whites, -6, accuracy: 1e-9)
    XCTAssertEqual(after.blacks, -9, accuracy: 1e-9)
    XCTAssertEqual(after.temperature, 5200, accuracy: 1e-9)
    XCTAssertEqual(after.tint, 8, accuracy: 1e-9)
    XCTAssertEqual(after.whiteBalancePreset, .auto)
    XCTAssertEqual(after.wbSource, .auto)
    XCTAssertEqual(after.wbAlgorithmVersion, autoWhiteBalanceAlgorithmVersion)
    // #1387: AUTO's exposure is measured against an AE-Off probe, so
    // autoExposure must flip alongside exposure — otherwise a
    // Profile.neutral decode double-counts the AE anchor gain.
    XCTAssertEqual(after.autoExposure, .off)
    // One undo entry restores the pre-AUTO model, tone included.
    XCTAssertTrue(state.canUndo)
    state.undo()
    XCTAssertEqual(state.session.model.exposure, AdjustmentModel.default.exposure, accuracy: 1e-9)
    XCTAssertEqual(state.session.model.contrast, 40, accuracy: 1e-9)
    XCTAssertEqual(state.session.model.autoExposure, AdjustmentModel.default.autoExposure)
    XCTAssertFalse(state.canUndo, "AUTO must create exactly one undo entry.")
  }

  /// #1387 — the exact regression this ticket closes: on `Profile.neutral`
  /// the Apple decode honours the sidecar's `auto_exposure` (default On)
  /// rather than forcing it off the way `Profile.auto` does, so AUTO must
  /// explicitly pin `autoExposure = .off` alongside its exposure
  /// recommendation or the AE anchor gain and AUTO's lift double-count,
  /// rendering too bright.
  func testApplyAutoSetsAutoExposureOffOnNeutralProfile() async {
    let session = makeFileBackedSession()
    let state = EditorState(session: session)
    state.autoProvider = { _ in
      AutoAdjustmentsResult(
        exposure: 0.8, temperature: 6500, tint: 0,
        contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0
      )
    }
    var dirty = session.model
    dirty.profile = .neutral
    XCTAssertEqual(dirty.autoExposure, .on, "precondition: fresh model starts AE-On")
    session.model = dirty

    await state.applyAuto()

    let after = state.session.model
    XCTAssertEqual(after.profile, .neutral, "AUTO must not touch the render profile")
    XCTAssertEqual(
      after.autoExposure, .off,
      "AUTO must pin autoExposure Off on Neutral so the decode it measured "
        + "the recommendation against is the one that actually renders")
  }

  func testApplyAutoClampsExposureToneAndWB() async {
    let session = makeFileBackedSession()
    let state = EditorState(session: session)
    state.autoProvider = { _ in
      AutoAdjustmentsResult(
        exposure: 99, temperature: 99999, tint: 999,
        contrast: 999, highlights: -999, shadows: 999, whites: -999, blacks: 999
      )
    }
    await state.applyAuto()
    let m = state.session.model
    XCTAssertEqual(m.exposure, AdjustmentModel.exposureRange.upperBound, accuracy: 1e-9)
    XCTAssertEqual(m.contrast, AdjustmentModel.contrastRange.upperBound, accuracy: 1e-9)
    XCTAssertEqual(m.highlights, AdjustmentModel.highlightsRange.lowerBound, accuracy: 1e-9)
    XCTAssertEqual(m.shadows, AdjustmentModel.shadowsRange.upperBound, accuracy: 1e-9)
    XCTAssertEqual(m.whites, AdjustmentModel.whitesRange.lowerBound, accuracy: 1e-9)
    XCTAssertEqual(m.blacks, AdjustmentModel.blacksRange.upperBound, accuracy: 1e-9)
    XCTAssertEqual(m.temperature, AdjustmentModel.temperatureRange.upperBound, accuracy: 1e-9)
    XCTAssertEqual(m.tint, AdjustmentModel.tintRange.upperBound, accuracy: 1e-9)
  }

  func testApplyAutoNoOpWhenOriginalBytesCannotBeRead() async {
    // The preview asset's bytes provider throws: source resolution fails
    // before the native analyzer runs, leaving model and history untouched.
    let state = EditorState(session: makeSession())
    state.autoProvider = { _ in
      XCTFail("Unavailable source must not reach native analysis")
      return AutoAdjustmentsResult(
        exposure: 1, temperature: 5000, tint: 0,
        contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0
      )
    }
    await state.applyAuto()
    XCTAssertEqual(state.session.model.exposure, AdjustmentModel.default.exposure, accuracy: 1e-9)
    XCTAssertFalse(state.canUndo)
  }

  /// #2255 — the tone sliders AUTO writes must round-trip through the REAL
  /// on-disk `.xmp` sidecar (no mocks — see CLAUDE.md § "No mocks for the
  /// sidecar layer" and `XMPSerializationAutoExposureTests.
  /// testSidecarStoreRoundTripAutoExposure`), proving the values reach the
  /// file exactly like any other slider edit would — not just the
  /// in-memory model applyAuto() writes.
  func testApplyAutoToneSurvivesRealXMPSidecarRoundTrip() async throws {
    let session = makeFileBackedSession()
    let state = EditorState(session: session)
    state.autoProvider = { _ in
      AutoAdjustmentsResult(
        exposure: 0.8, temperature: 6500, tint: 0,
        contrast: 15, highlights: -20, shadows: 25, whites: -8, blacks: -12
      )
    }
    await state.applyAuto()
    let applied = state.session.model

    let tmp = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension("dng")
    let xmpURL = tmp.deletingPathExtension().appendingPathExtension("xmp")
    defer { try? FileManager.default.removeItem(at: xmpURL) }

    let store = XMPSidecarStore(rawURL: tmp)
    await store.update(model: applied, culling: CullingState())
    await store.flush()

    // The raw XML on disk actually carries the calibrated values.
    let xml = try String(contentsOf: xmpURL, encoding: .utf8)
    XCTAssertTrue(xml.contains(#"crs:Contrast2012="15""#))
    XCTAssertTrue(xml.contains(#"crs:Highlights2012="-20""#))
    XCTAssertTrue(xml.contains(#"crs:Shadows2012="25""#))
    XCTAssertTrue(xml.contains(#"crs:Whites2012="-8""#))
    XCTAssertTrue(xml.contains(#"crs:Blacks2012="-12""#))

    // Drop the in-memory cache so the read actually goes to disk.
    let fresh = XMPSidecarStore(rawURL: tmp)
    let (onDisk, _) = try await fresh.load()
    XCTAssertEqual(onDisk.exposure, 0.8, accuracy: 1e-9)
    XCTAssertEqual(onDisk.contrast, 15, accuracy: 1e-9)
    XCTAssertEqual(onDisk.highlights, -20, accuracy: 1e-9)
    XCTAssertEqual(onDisk.shadows, 25, accuracy: 1e-9)
    XCTAssertEqual(onDisk.whites, -8, accuracy: 1e-9)
    XCTAssertEqual(onDisk.blacks, -12, accuracy: 1e-9)
    XCTAssertEqual(onDisk.autoExposure, .off)
    XCTAssertEqual(onDisk.whiteBalancePreset, .auto)
    XCTAssertEqual(onDisk.wbSource, .auto)
    XCTAssertEqual(onDisk.wbAlgorithmVersion, autoWhiteBalanceAlgorithmVersion)
    XCTAssertEqual(onDisk.temperature, applied.temperature)
    XCTAssertEqual(onDisk.tint, applied.tint)
  }
}

private actor AutoAnalysisGate {
  private var isOpen = false
  private var continuation: CheckedContinuation<Void, Never>?

  func wait() async {
    guard !isOpen else { return }
    await withCheckedContinuation { continuation = $0 }
  }

  func open() {
    isOpen = true
    continuation?.resume()
    continuation = nil
  }
}
