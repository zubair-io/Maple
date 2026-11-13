import XCTest

@testable import MapleCore

final class AdjustmentTransferTests: XCTestCase {
  func testPreGradingDurableTransferDecodesMissingFieldsAndResumes() throws {
    var before = AdjustmentModel.default
    before.exposure = 0.5
    var after = before
    after.exposure = 1.25
    let patch = PreparedAdjustmentTransfer(
      model: after, groupIDs: [AdjustmentGroup.tone.rawValue], before: before)
    var json = try XCTUnwrap(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
    let newKeys = [
      "colorGradeBlending", "colorGradeShadowEdge", "colorGradeHighlightEdge",
      "colorCurveHueVsHue", "colorCurveHueVsSat", "colorCurveHueVsLuma",
      "colorCurveLumaVsSat", "colorCurveSatVsSat", "colorCurveSatVsLuma",
    ]
    for key in ["model", "before"] {
      var model = try XCTUnwrap(json[key] as? [String: Any])
      for field in newKeys { model.removeValue(forKey: field) }
      json[key] = model
    }
    let restored = try JSONDecoder().decode(
      PreparedAdjustmentTransfer.self, from: JSONSerialization.data(withJSONObject: json))
    XCTAssertEqual(restored, patch)
    XCTAssertNoThrow(try restored.validate(current: before))
    XCTAssertEqual(restored.applying(to: before).exposure, 1.25)
  }

  func testGradingTransferKeepsExplicitValuesAndRejectsMalformedFields() throws {
    var model = AdjustmentModel.default
    model.colorGradeBlending = 32
    model.colorGradeShadowEdge = 0.2
    model.colorGradeHighlightEdge = 0.8
    model.colorCurveHueVsSat = ToneCurve(points: [(0.2, 0), (0.3, 0.4), (0.4, 0)])
    let data = try JSONEncoder().encode(model)
    XCTAssertEqual(try JSONDecoder().decode(AdjustmentModel.self, from: data), model)
    var json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(json["colorGradeBlending"] as? Double, 32)
    json["colorGradeBlending"] = "malformed"
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        AdjustmentModel.self, from: JSONSerialization.data(withJSONObject: json)))
  }

  func testRelativeWhiteBalanceUsesEachCamerasOwnBaselineAndClearsSampleLocation() throws {
    var source = AdjustmentModel.default
    source.temperature = 8550
    source.tint = 24
    source.wbSource = .sampled
    source.wbSampleX = 0.3
    source.wbSampleY = 0.7
    source.wbAlgorithmVersion = 1
    var target = AdjustmentModel.default
    target.exposure = 2
    target.crop = Crop(top: 0.1, left: 0.2, bottom: 0.8, right: 0.9)
    let patch = try AdjustmentTransfer.prepare(
      source: source, groups: [.whiteBalance], relativeWhiteBalance: true,
      sourceBaseline: .init(temperature: 7350, tint: 14),
      targetBaseline: .init(temperature: 5050, tint: 38))
    let result = patch.applying(to: target)
    XCTAssertEqual(result.temperature, 6250)
    XCTAssertEqual(result.tint, 48)
    XCTAssertEqual(result.wbSource, .manual)
    XCTAssertEqual(result.wbSampleX, 0)
    XCTAssertEqual(result.wbSampleY, 0)
    XCTAssertEqual(result.wbAlgorithmVersion, 0)
    XCTAssertEqual(result.exposure, target.exposure)
    XCTAssertEqual(result.crop, target.crop)
  }

  func testAsShotSourceHasZeroDeltaEvenBeforeItsSlidersAreSeeded() throws {
    let patch = try AdjustmentTransfer.prepare(
      source: .default, groups: [.whiteBalance], relativeWhiteBalance: true,
      sourceBaseline: .init(temperature: 7350, tint: 14),
      targetBaseline: .init(temperature: 5050, tint: 38))
    XCTAssertEqual(patch.model.temperature, 5050)
    XCTAssertEqual(patch.model.tint, 38)
  }

  func testRelativeClampsGeneratedRangesAndRejectsUnknownScaleOrMissingBaseline() throws {
    var source = AdjustmentModel.default
    source.wbSource = .manual
    source.temperature = 12000
    source.tint = 150
    let baseline = WhiteBalanceTransferBaseline(temperature: 2000, tint: -150)
    let patch = try AdjustmentTransfer.prepare(
      source: source, groups: [.whiteBalance], relativeWhiteBalance: true,
      sourceBaseline: baseline, targetBaseline: .init(temperature: 11000, tint: 140))
    XCTAssertEqual(patch.model.temperature, AdjustmentModel.temperatureRange.upperBound)
    XCTAssertEqual(patch.model.tint, AdjustmentModel.tintRange.upperBound)
    for version: Int in [1, 4, 6] {
      source.wbScaleVersion = version
      XCTAssertThrowsError(
        try AdjustmentTransfer.prepare(
          source: source, groups: [.whiteBalance], relativeWhiteBalance: true,
          sourceBaseline: baseline, targetBaseline: baseline))
    }
    source.wbScaleVersion = AdjustmentModel.default.wbScaleVersion
    XCTAssertThrowsError(
      try AdjustmentTransfer.prepare(
        source: source, groups: [.whiteBalance], relativeWhiteBalance: true,
        sourceBaseline: baseline))
  }

  func testAbsoluteNeedsNoBaselineAndPreparedReplayPreservesLaterUnselectedEdits() throws {
    var source = AdjustmentModel.default
    source.temperature = 8550
    source.tint = 24
    source.wbScaleVersion = 1
    let patch = try AdjustmentTransfer.prepare(
      source: source, groups: [.whiteBalance], relativeWhiteBalance: false)
    let restored = try JSONDecoder().decode(
      PreparedAdjustmentTransfer.self, from: JSONEncoder().encode(patch))
    var target = AdjustmentModel.default
    target.exposure = 1.75
    XCTAssertEqual(restored.applying(to: target).temperature, 8550)
    XCTAssertEqual(restored.applying(to: target).wbScaleVersion, 1)
    XCTAssertEqual(restored.applying(to: target).exposure, 1.75)
  }

  func testAllGeneratedCurveFamiliesAndFilmSelectionTransfer() throws {
    var source = AdjustmentModel.default
    let curve = ToneCurve(points: [(0, 0), (0.5, 0.65), (1, 1)])
    source.toneCurveLuma = curve
    source.toneCurveRed = curve
    source.toneCurveGreen = curve
    source.toneCurveBlue = curve
    source.displayToneCurveLuma = curve
    source.displayToneCurveRed = curve
    source.displayToneCurveGreen = curve
    source.displayToneCurveBlue = curve
    source.filmLook = "black_white_ilford_hp_5_plus_400"
    let patch = try AdjustmentTransfer.prepare(
      source: source, groups: [.tone, .effects], relativeWhiteBalance: false)
    let merged = patch.applying(to: .default)
    XCTAssertEqual(merged.toneCurveLuma, curve)
    XCTAssertEqual(merged.toneCurveRed, curve)
    XCTAssertEqual(merged.toneCurveGreen, curve)
    XCTAssertEqual(merged.toneCurveBlue, curve)
    XCTAssertEqual(merged.displayToneCurveLuma, curve)
    XCTAssertEqual(merged.displayToneCurveRed, curve)
    XCTAssertEqual(merged.displayToneCurveGreen, curve)
    XCTAssertEqual(merged.displayToneCurveBlue, curve)
    XCTAssertEqual(merged.filmLook, source.filmLook)
  }
  func testAsShotPreparedReplayIgnoresUnpersistedCameraSeedValues() throws {
    var before = AdjustmentModel.default
    before.temperature = 5050
    before.tint = 38
    var source = AdjustmentModel.default
    source.temperature = 7350
    source.tint = 14
    let patch = PreparedAdjustmentTransfer(
      model: source, groupIDs: [AdjustmentGroup.whiteBalance.rawValue], before: before)
    let xml = XMPSerializer.serialize(model: patch.applying(to: before), culling: CullingState())
    let reopened = try XMPParser.parse(data: Data(xml.utf8)).0
    XCTAssertNoThrow(try patch.validate(current: reopened))
  }

  func testColdAsShotReviewDoesNotPresentUnseededDefaultsAsCameraValues() throws {
    var after = AdjustmentModel.default
    after.wbSource = .manual
    after.temperature = 6250
    after.tint = 48
    let fields = try AdjustmentTransferDiff.fields(
      group: .whiteBalance, before: .default, after: after)
    XCTAssertEqual(fields.first { $0.id == "temperature" }?.before, "As Shot")
    XCTAssertEqual(fields.first { $0.id == "temperature" }?.after, "6250")
    XCTAssertEqual(fields.first { $0.id == "tint" }?.before, "As Shot")
  }

  func testReviewIncludesOptionalValueDeletionAndIntroduction() throws {
    let saved: [String: Any] = ["whiteBalancePreset": "Daylight", "temperature": 5500]
    let custom: [String: Any] = ["temperature": 5500]
    let cleared = try AdjustmentTransferDiff.differences(before: saved, after: custom)
    XCTAssertEqual(cleared.map(\.id), ["whiteBalancePreset"])
    XCTAssertEqual(cleared.first?.label, "White balance preset")
    XCTAssertEqual(cleared.first?.before, "Daylight")
    XCTAssertEqual(cleared.first?.after, "Custom")
    let restored = try AdjustmentTransferDiff.differences(before: custom, after: saved)
    XCTAssertEqual(restored.first?.before, "Custom")
    XCTAssertEqual(restored.first?.after, "Daylight")
  }

}
