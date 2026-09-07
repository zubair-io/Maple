import XCTest

@testable import MapleCore

@MainActor
final class EditorCommandRouterTests: XCTestCase {
  private func makeRouter() -> EditorCommandRouter {
    let session = EditSession.preview()
    session.nativeImageSize = CGSize(width: 4000, height: 3000)
    let state = EditorState(session: session)
    state.zoom.viewportChanged(points: CGSize(width: 800, height: 600), displayScale: 1)
    addTeardownBlock { await session.renderActor.cancelAll() }
    return EditorCommandRouter(state: state)
  }

  private func run(_ command: EditorCommandRouter.Command, _ router: EditorCommandRouter) {
    XCTAssertTrue(router.perform(command, assetID: router.state.session.asset.id))
  }

  func testUndoRedoAndResetUseTheExistingTransactionRing() {
    let router = makeRouter()
    let state = router.state
    state.beginSliderInteraction(tool: .exposure)
    state.setArmedDisplayValue(0.5)
    state.setArmedDisplayValue(1)
    state.endGesture()
    XCTAssertEqual(state.session.undoHistory.count, 1)
    run(.undo, router)
    XCTAssertEqual(state.session.model.exposure, 0)
    run(.redo, router)
    XCTAssertEqual(state.session.model.exposure, 1)
    run(.resetGroup, router)
    XCTAssertEqual(state.session.model.exposure, 0)
    XCTAssertEqual(state.session.undoHistory.count, 2)
    run(.undo, router)
    XCTAssertEqual(state.session.model.exposure, 1)
  }

  func testHeldGlobalNudgeRecordsOneUndoOnRelease() {
    let router = makeRouter()
    let session = router.state.session
    for _ in 0..<5 { run(.nudge(1), router) }
    let after = session.model.exposure
    XCTAssertGreaterThan(after, 0)
    XCTAssertTrue(session.undoHistory.isEmpty)
    run(.nudgeRelease, router)
    XCTAssertEqual(session.undoHistory.count, 1)
    run(.undo, router)
    XCTAssertEqual(session.model.exposure, 0)
    run(.redo, router)
    XCTAssertEqual(session.model.exposure, after)
    run(.nudge(-1), router)
    router.finishNudge()
    XCTAssertEqual(session.undoHistory.count, 2)
  }

  func testUnownedArrowReleaseIsIgnoredBeforeAndAfterAHeldNudge() {
    let router = makeRouter()
    let assetID = router.state.session.asset.id
    XCTAssertFalse(router.perform(.nudgeRelease, assetID: assetID))
    XCTAssertTrue(router.state.session.undoHistory.isEmpty)
    run(.nudge(1), router)
    run(.nudgeRelease, router)
    XCTAssertFalse(router.perform(.nudgeRelease, assetID: assetID))
    XCTAssertEqual(router.state.session.undoHistory.count, 1)
    run(.nudge(1), router)
    router.finishNudge()
    XCTAssertFalse(router.perform(.nudgeRelease, assetID: assetID))
    XCTAssertEqual(router.state.session.undoHistory.count, 2)
  }

  func testHeldGlobalNudgeDefersDecodeProductUntilRelease() {
    let router = makeRouter()
    let state = router.state
    let deep = Tool.noise.subParams.first { $0.commitsOnRelease }!
    state.arm(tool: .noise)
    state.arm(subParamId: deep.id)
    let before = state.session.model
    for _ in 0..<3 { run(.nudge(1), router) }
    XCTAssertEqual(state.session.model, before)
    XCTAssertNotNil(state.deferredDisplayValue)
    run(.nudgeRelease, router)
    XCTAssertNotEqual(state.session.model, before)
    XCTAssertEqual(state.session.undoHistory.count, 1)
    run(.undo, router)
    XCTAssertEqual(state.session.model, before)
  }

  func testClampOnlyNudgeDoesNotClearRedoOrOpenAnUndoEntry() {
    let router = makeRouter()
    for _ in 0..<20 { run(.nudge(-1), router) }
    run(.nudgeRelease, router)
    run(.nudge(1), router)
    run(.nudgeRelease, router)
    run(.undo, router)
    let count = router.state.session.undoHistory.count
    run(.nudge(-1), router)
    XCTAssertFalse(router.perform(.nudgeRelease, assetID: router.state.session.asset.id))
    XCTAssertTrue(router.state.canRedo)
    XCTAssertEqual(router.state.session.undoHistory.count, count)
  }

  func testModifiedStyleIgnoresOnlyFloatingPointResidue() {
    let range = AdjustmentModel.exposureRange
    XCTAssertFalse(
      LivingSliderMath.isModified(value: 0.1 + 0.2 - 0.3, defaultValue: 0, range: range))
    XCTAssertTrue(LivingSliderMath.isModified(value: 0.001, defaultValue: 0, range: range))
    XCTAssertFalse(
      LivingSliderMath.isModified(
        value: 6500 + 1e-10, defaultValue: 6500,
        range: AdjustmentModel.temperatureRange))
  }

  func testZoomStepsAreBoundedAndKeepTheCenterAnchor() {
    let router = makeRouter()
    let zoom = router.state.zoom
    run(.actualSize, router)
    run(.pan(x: 100, y: 80), router)
    let before = zoom.panOffset
    let scale = zoom.effectivePixelScale
    run(.zoomIn, router)
    let ratio = zoom.effectivePixelScale / scale
    XCTAssertEqual(zoom.panOffset.width, before.width * ratio, accuracy: 0.001)
    XCTAssertEqual(zoom.panOffset.height, before.height * ratio, accuracy: 0.001)
    for _ in 0..<30 { run(.zoomIn, router) }
    XCTAssertEqual(zoom.effectivePixelScale, CanvasZoomModel.maxPixelScale)
    run(.pan(x: 1_000_000, y: -1_000_000), router)
    let limit = zoom.context.maxPanOffset(at: zoom.model.pixelScale)
    XCTAssertEqual(zoom.panOffset.width, limit.width)
    XCTAssertEqual(zoom.panOffset.height, -limit.height)
    run(.fit, router)
    XCTAssertFalse(zoom.isZoomedIn)
    XCTAssertEqual(zoom.panOffset, .zero)
    run(.pan(x: 100, y: 100), router)
    XCTAssertEqual(zoom.panOffset, .zero)
    XCTAssertTrue(router.state.session.undoHistory.isEmpty)
  }

  func testCompareTapHoldAndCancellationPreserveGeometryAndEdits() async throws {
    let router = makeRouter()
    let session = router.state.session
    run(.actualSize, router)
    run(.pan(x: 80, y: 40), router)
    let zoom = router.state.zoom.model
    let model = session.model
    run(.comparePress, router)
    XCTAssertTrue(session.showingOriginal)
    run(.compareRelease, router)
    XCTAssertTrue(session.showingOriginal, "A tap latches comparison")
    run(.compareToggle, router)
    XCTAssertFalse(session.showingOriginal)
    run(.comparePress, router)
    try await Task.sleep(for: .milliseconds(320))
    run(.compareRelease, router)
    XCTAssertFalse(session.showingOriginal, "A hold restores the previous latched state")
    run(.comparePress, router)
    router.cancelCompare()
    XCTAssertFalse(session.showingOriginal)
    XCTAssertEqual(router.state.zoom.model, zoom)
    XCTAssertEqual(session.model, model)
    XCTAssertFalse(session.canUndo)
  }

  func testOldAssetAndRemovedEditorCommandsAreRejected() {
    let router = makeRouter()
    XCTAssertFalse(router.perform(.nudge(1), assetID: UUID()))
    run(.comparePress, router)
    router.deactivate()
    XCTAssertFalse(router.state.session.showingOriginal)
    XCTAssertFalse(router.perform(.compareRelease, assetID: router.state.session.asset.id))
    XCTAssertFalse(router.perform(.nudge(1), assetID: router.state.session.asset.id))
    XCTAssertEqual(router.state.session.model.exposure, 0)
  }

  func testNavigationDiscardsDeferredValueOnItsOriginalSession() {
    let router = makeRouter()
    let state = router.state
    let deep = Tool.noise.subParams.first { $0.commitsOnRelease }!
    state.beginSliderInteraction(tool: .noise, subParamID: deep.id)
    let original = state.session.model
    state.setArmedDisplayValue(deep.range.upperBound)
    XCTAssertNotNil(state.deferredDisplayValue)
    router.deactivate()
    XCTAssertNil(state.deferredDisplayValue)
    XCTAssertEqual(state.session.model, original)
    XCTAssertFalse(state.canUndo)
  }

  func testKeyboardPrecisionMatchesTheGeneratedRangeContract() {
    XCTAssertEqual(LivingSliderMath.keyboardStep(range: AdjustmentModel.exposureRange), 0.01)
    XCTAssertEqual(LivingSliderMath.keyboardStep(range: AdjustmentModel.temperatureRange), 50)
    XCTAssertEqual(LivingSliderMath.keyboardStep(range: AdjustmentModel.contrastRange), 1)
  }

  func testUnarmedSliderStartsTheDisplayedPrimaryFieldBeforeItsFirstWrite() {
    let router = makeRouter()
    let state = router.state
    state.arm(tool: .sharpen)
    state.arm(subParamId: "radius")
    state.arm(tool: .exposure)
    let oldRadius = state.session.model.sharpenRadius
    state.beginSliderInteraction(tool: .sharpen, subParamID: Tool.sharpen.subParams.first?.id)
    state.setArmedDisplayValue(41)
    state.endGesture()
    XCTAssertEqual(state.session.model.sharpenAmount, 41)
    XCTAssertEqual(state.session.model.sharpenRadius, oldRadius)
    run(.undo, router)
    XCTAssertEqual(state.session.model.sharpenAmount, 40)
  }

  func testNoOpGroupResetPreservesRedo() {
    let router = makeRouter()
    let state = router.state
    state.beginSliderInteraction(tool: .exposure)
    state.setArmedDisplayValue(1)
    state.endGesture()
    run(.undo, router)
    run(.resetGroup, router)
    XCTAssertTrue(state.canRedo)
    run(.redo, router)
    XCTAssertEqual(state.session.model.exposure, 1)
  }
}
