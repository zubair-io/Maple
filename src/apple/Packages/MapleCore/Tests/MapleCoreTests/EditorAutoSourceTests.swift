import XCTest

@testable import MapleCore

@MainActor
final class EditorAutoSourceTests: XCTestCase {
  private var fixtureURL: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // MapleCoreTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // MapleCore
      .deletingLastPathComponent()  // Packages
      .deletingLastPathComponent()  // apple
      .appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
  }

  /// Real bytes, staging, native analysis and model application. This catches
  /// the former path-only early return for PhotoKit/cloud originals.
  func testNativeAutoAppliesToBytesBackedRawWithoutChangingOriginal() async throws {
    let bytes = try Data(contentsOf: fixtureURL)
    let originalDate =
      try FileManager.default.attributesOfItem(atPath: fixtureURL.path)[.modificationDate] as? Date
    let asset = AssetRef(
      displayName: "PhotoKit RAW", hintExtension: "dng", explicitIsRaw: true,
      thumbnailProvenance: .photoKit, bytesProvider: { bytes })
    var model = AdjustmentModel.default
    model.temperature = 5100
    model.tint = 7
    let session = EditSession(asset: asset, model: model)
    registerSessionTeardown(session)
    let state = EditorState(session: session)
    XCTAssertNil(asset.primaryURL)

    let expected = try await AutoAdjustments.compute(forRawAt: fixtureURL)
    await state.applyAuto()

    XCTAssertEqual(session.model.autoExposure, .off, "Native AUTO must actually apply its result")
    XCTAssertEqual(session.model.temperature, expected.temperature)
    XCTAssertEqual(session.model.tint, expected.tint)
    XCTAssertEqual(session.model.wbSource, .auto)
    XCTAssertEqual(session.model.wbAlgorithmVersion, autoWhiteBalanceAlgorithmVersion)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertFalse(state.autoInProgress)
    let staged = try await session.renderActor.rawRenderSource.url(for: asset)
    XCTAssertNotEqual(staged, fixtureURL)
    XCTAssertEqual(try Data(contentsOf: staged), bytes)
    XCTAssertEqual(try Data(contentsOf: fixtureURL), bytes)
    XCTAssertEqual(
      try FileManager.default.attributesOfItem(atPath: fixtureURL.path)[.modificationDate] as? Date,
      originalDate)
    state.undo()
    XCTAssertEqual(session.model, model)
  }

  func testCancellationDuringSourceDownloadNeverStartsAnalysis() async throws {
    let bytes = try Data(contentsOf: fixtureURL)
    let started = expectation(description: "Original download started")
    let gate = AutoSourceGate()
    let asset = AssetRef(displayName: "Cloud RAW", hintExtension: "dng") {
      if await gate.takeFirstRequest() { started.fulfill() }
      await gate.wait()
      return bytes
    }
    let session = EditSession(asset: asset)
    registerSessionTeardown(session)
    let state = EditorState(session: session)
    state.autoProvider = { _ in
      XCTFail("Cancelled source download must not start analysis")
      throw AutoAdjustmentsError.unsupportedAsset
    }
    let task = Task { @MainActor in await state.applyAuto() }
    await fulfillment(of: [started], timeout: 5)
    task.cancel()
    await gate.open()
    await task.value

    XCTAssertEqual(session.model, .default)
    XCTAssertFalse(state.canUndo)
    XCTAssertFalse(state.autoInProgress)
  }

  func testNonRawAssetNeverStartsAnalysis() async {
    let asset = AssetRef(url: URL(fileURLWithPath: "/tmp/maple-auto-nonraw.jpg"))
    let session = EditSession(asset: asset)
    registerSessionTeardown(session)
    let state = EditorState(session: session)
    state.autoProvider = { _ in
      XCTFail("Non-RAW asset must not reach native analysis")
      throw AutoAdjustmentsError.unsupportedAsset
    }

    await state.applyAuto()

    XCTAssertEqual(session.model, .default)
    XCTAssertFalse(state.canUndo)
    XCTAssertFalse(state.autoInProgress)
  }

  func testEditThenUndoDuringSourceDownloadDiscardsAuto() async throws {
    let bytes = try Data(contentsOf: fixtureURL)
    let started = expectation(description: "Original download started")
    let gate = AutoSourceGate()
    let asset = AssetRef(displayName: "Cloud RAW", hintExtension: "dng") {
      if await gate.takeFirstRequest() { started.fulfill() }
      await gate.wait()
      return bytes
    }
    let session = EditSession(asset: asset)
    registerSessionTeardown(session)
    let state = EditorState(session: session)
    state.autoProvider = { _ in
      XCTFail("An intervening edit must invalidate AUTO before analysis")
      throw AutoAdjustmentsError.unsupportedAsset
    }
    let task = Task { @MainActor in await state.applyAuto() }
    await fulfillment(of: [started], timeout: 5)
    state.commit(description: "Manual exposure")
    session.model.exposure = -1.5
    session.endEdit()
    state.undo()

    await gate.open()
    await task.value

    XCTAssertEqual(session.model, .default)
    XCTAssertFalse(state.canUndo)
    XCTAssertTrue(state.canRedo, "Discarding AUTO must preserve redo")
    XCTAssertFalse(state.autoInProgress)
  }

  private func registerSessionTeardown(_ session: EditSession) {
    addTeardownBlock {
      // Model application/undo also schedules real rendering. Settle the
      // current pass and cancel its pending refine before the next test.
      await session.renderActor.awaitCurrentRenderIfInFlight()
      await session.renderActor.cancelAll()
      await session.releaseTransientMemory()
    }
  }
}

private actor AutoSourceGate {
  private var requested = false
  private var isOpen = false
  private var continuations: [CheckedContinuation<Void, Never>] = []

  func takeFirstRequest() -> Bool {
    guard !requested else { return false }
    requested = true
    return true
  }

  func wait() async {
    guard !isOpen else { return }
    await withCheckedContinuation { continuations.append($0) }
  }

  func open() {
    isOpen = true
    for continuation in continuations { continuation.resume() }
    continuations.removeAll()
  }
}
