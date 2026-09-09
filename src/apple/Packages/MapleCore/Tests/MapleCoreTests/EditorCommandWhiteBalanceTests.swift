import XCTest

@testable import MapleCore

@MainActor
final class EditorCommandWhiteBalanceTests: EditorTestCase {
  func testHeldTemperatureNudgePreservesPresetUndoAndDecodedCacheIdentity() async {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    let router = EditorCommandRouter(state: state)
    await state.applyWhiteBalancePreset(.daylight)
    let preset = session.model
    XCTAssertEqual(preset.whiteBalancePreset, .daylight)
    XCTAssertEqual(preset.wbSource, .preset)
    state.arm(tool: .temp)

    for _ in 0..<3 {
      XCTAssertTrue(router.perform(.nudge(1), assetID: session.asset.id))
    }
    XCTAssertTrue(router.perform(.nudgeRelease, assetID: session.asset.id))

    let adjusted = session.model
    XCTAssertGreaterThan(adjusted.temperature, preset.temperature)
    XCTAssertEqual(adjusted.whiteBalancePreset, .custom)
    XCTAssertEqual(adjusted.wbSource, .manual)
    XCTAssertEqual(session.undoHistory.count, 2, "One preset edit and one held-key edit")
    XCTAssertEqual(
      RawCoreBridge.stripAppleGPUStages(adjusted), RawCoreBridge.stripAppleGPUStages(preset))
    XCTAssertTrue(router.perform(.undo, assetID: session.asset.id))
    XCTAssertEqual(session.model, preset)
    XCTAssertTrue(router.perform(.redo, assetID: session.asset.id))
    XCTAssertEqual(session.model, adjusted)
    await session.releaseTransientMemory()
  }
}
