import XCTest

@testable import MapleCore

@MainActor
final class WhiteBalancePickerTests: XCTestCase {
  private let point = CGPoint(x: 0.25, y: 0.75)
  private var result: WhiteBalanceSample {
    WhiteBalanceSample(temperature: 5300, tint: 12, algorithmVersion: 1)
  }

  func testSampleIsOneUndoableActionAndPersistsCompleteProvenance() async throws {
    let session = EditSession.preview()
    let before = session.model
    let picker = WhiteBalancePicker(session: session)
    let result = result
    picker.provider = { _, _, _ in result }
    picker.arm()
    await picker.pick(at: point)
    XCTAssertFalse(picker.isArmed)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.model.temperature, 5300)
    XCTAssertEqual(session.model.tint, 12)
    XCTAssertEqual(session.model.wbSource, .sampled)
    XCTAssertEqual(session.model.wbSampleX, point.x)
    XCTAssertEqual(session.model.wbSampleY, point.y)
    XCTAssertEqual(session.model.wbAlgorithmVersion, 1)
    XCTAssertTrue(picker.provenance.contains("(0.250, 0.750)"))
    XCTAssertTrue(picker.provenance.contains("version 1"))
    let sampled = session.model
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("sample.xmp")
    try XMPSerializer.serialize(model: sampled, culling: CullingState()).write(
      to: url, atomically: true, encoding: .utf8)
    let (reopened, _) = try XMPParser.parse(String(contentsOf: url, encoding: .utf8))
    XCTAssertEqual(reopened.wbSource, .sampled)
    XCTAssertEqual(reopened.wbSampleX, point.x)
    XCTAssertEqual(reopened.wbSampleY, point.y)
    XCTAssertEqual(reopened.wbAlgorithmVersion, 1)
    XCTAssertEqual(reopened.temperature, sampled.temperature)
    XCTAssertEqual(reopened.tint, sampled.tint)
    session.undo()
    XCTAssertEqual(session.model, before)
    session.redo()
    XCTAssertEqual(session.model, sampled)
  }

  func testNewSampleAndAsShotReplaceLegacyScaleAndUndoRestoresIt() async {
    var legacy = AdjustmentModel.default
    legacy.wbScaleVersion = 1
    legacy.temperature = 4200
    legacy.tint = 5
    let session = EditSession.preview(model: legacy)
    let picker = WhiteBalancePicker(session: session)
    let result = result
    picker.provider = { _, _, _ in result }
    picker.arm()
    await picker.pick(at: point)
    XCTAssertEqual(session.model.wbScaleVersion, AdjustmentModel.default.wbScaleVersion)
    XCTAssertEqual(session.model.temperature, result.temperature)
    session.undo()
    XCTAssertEqual(session.model, legacy)
    session.asShotCCT = 5100
    session.asShotTint = 4
    picker.resetToAsShot()
    XCTAssertEqual(session.model.wbScaleVersion, AdjustmentModel.default.wbScaleVersion)
    XCTAssertEqual(session.model.temperature, 5100)
    session.undo()
    XCTAssertEqual(session.model, legacy)
  }

  func testRejectionsKeepPickerArmedWithoutEditsAndExplainNextPick() async {
    for code: Int32 in [11, 12, 13, 14] {
      let session = EditSession.preview()
      let picker = WhiteBalancePicker(session: session)
      picker.provider = { _, _, _ in throw WhiteBalanceSampleError(code: code) }
      picker.arm()
      await picker.pick(at: point)
      XCTAssertTrue(picker.isArmed)
      XCTAssertFalse(picker.isSampling)
      XCTAssertTrue(session.undoHistory.isEmpty)
      XCTAssertEqual(session.model, .default)
      XCTAssertTrue(picker.message?.contains("Pick") == true)
    }
  }

  func testUnchangedAsShotDoesNotEraseRedo() {
    let session = EditSession.preview()
    session.asShotCCT = session.model.temperature
    session.asShotTint = session.model.tint
    session.beginEdit(description: "Exposure")
    session.model.exposure = 1
    session.endEdit()
    session.undo()
    let picker = WhiteBalancePicker(session: session)
    picker.resetToAsShot()
    XCTAssertTrue(session.canRedo)
  }

  func testOutsideCanvasDoesNotInvokeTheSampler() async {
    let picker = WhiteBalancePicker(session: .preview())
    picker.provider = { _, _, _ in
      XCTFail("Outside click reached sampler")
      throw WhiteBalanceSampleError.failed
    }
    picker.arm()
    await picker.pick(at: nil)
    XCTAssertEqual(picker.message, WhiteBalanceSampleError.outsideImage.localizedDescription)
  }

  func testLateResultCannotOverwriteAnEditOrSurviveCancel() async {
    for cancel in [false, true] {
      let session = EditSession.preview()
      let picker = WhiteBalancePicker(session: session)
      let gate = SampleGate()
      picker.provider = { _, _, _ in await gate.wait() }
      picker.arm()
      let pick = Task { await picker.pick(at: point) }
      await gate.awaitRequest()
      if cancel {
        picker.cancel()
      } else {
        session.beginEdit(description: "Exposure")
        session.model.exposure = 1
        session.endEdit()
        // Returning to the original values is still a newer edit.
        session.undo()
      }
      await gate.finish(result)
      await pick.value
      XCTAssertEqual(session.model.wbSource, .asShot)
      XCTAssertEqual(session.model.temperature, AdjustmentModel.default.temperature)
    }
  }

  func testManualSlidersAndAsShotClearSampleProvenanceAndUndoRestoresIt() async {
    let session = EditSession.preview()
    let picker = WhiteBalancePicker(session: session)
    let result = result
    picker.provider = { _, _, _ in result }
    picker.arm()
    await picker.pick(at: point)
    session.beginEdit(description: "Temperature")
    ToolValueMapping.apply(6000, to: &session.model, tool: .temp)
    session.endEdit()
    XCTAssertEqual(session.model.wbSource, .manual)
    XCTAssertEqual(session.model.wbAlgorithmVersion, 0)
    session.undo()
    XCTAssertEqual(session.model.wbSource, .sampled)
    session.asShotCCT = 5100
    session.asShotTint = 4
    picker.resetToAsShot()
    XCTAssertEqual(session.model.wbSource, .asShot)
    XCTAssertEqual(session.model.wbSampleX, 0)
    XCTAssertEqual(session.model.wbAlgorithmVersion, 0)
    XCTAssertEqual(session.model.temperature, 5100)
    session.undo()
    XCTAssertEqual(session.model.wbSource, .sampled)
  }
}

private actor SampleGate {
  private var continuation: CheckedContinuation<WhiteBalanceSample, Never>?
  private var waiter: CheckedContinuation<Void, Never>?
  func wait() async -> WhiteBalanceSample {
    await withCheckedContinuation {
      continuation = $0
      waiter?.resume()
      waiter = nil
    }
  }
  func awaitRequest() async {
    if continuation != nil { return }
    await withCheckedContinuation { waiter = $0 }
  }
  func finish(_ result: WhiteBalanceSample) { continuation?.resume(returning: result) }
}
