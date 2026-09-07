import XCTest

@testable import MapleCore

final class WhiteBalanceTransferProvenanceTests: XCTestCase {
  private var sampled: AdjustmentModel {
    var model = AdjustmentModel.default
    model.temperature = 5300
    model.tint = 10
    model.wbSource = .sampled
    model.wbSampleX = 0.25
    model.wbSampleY = 0.75
    model.wbAlgorithmVersion = 1
    return model
  }

  func testWhiteBalancePasteDoesNotRetainTheTargetsOldSamplePoint() {
    var source = sampled
    source.temperature = 5900
    source.wbSampleX = 0.8
    let pasted = AdjustmentGroupMerge.merged(sampled, applying: source, groups: [.whiteBalance])
    XCTAssertEqual(pasted.temperature, 5900)
    XCTAssertEqual(pasted.wbSource, .sampled)
    assertNoDerivation(pasted)
    let toneOnly = AdjustmentGroupMerge.merged(sampled, applying: .default, groups: [.tone])
    XCTAssertEqual(toneOnly.wbSource, .sampled)
    XCTAssertEqual(toneOnly.wbSampleX, sampled.wbSampleX)
    XCTAssertEqual(toneOnly.wbAlgorithmVersion, 1)
  }

  func testManualWhiteBalanceTransferClearsPresetNameButAbsolutePresetRetainsIt() {
    var source = sampled
    source.whiteBalancePreset = .daylight
    source.wbSource = .manual
    let manual = AdjustmentGroupMerge.merged(sampled, applying: source, groups: [.whiteBalance])
    XCTAssertEqual(manual.whiteBalancePreset, .custom)
    XCTAssertEqual(manual.wbSource, .manual)
    assertNoDerivation(manual)
    source.wbSource = .preset
    let preset = AdjustmentGroupMerge.merged(sampled, applying: source, groups: [.whiteBalance])
    XCTAssertEqual(preset.whiteBalancePreset, .daylight)
    XCTAssertEqual(preset.wbSource, .preset)
    assertNoDerivation(preset)
  }

  func testNumericWhiteBalancePresetSetsPresetSourceAndDropsOldDerivation() {
    for key in ["temperature", "tint"] {
      let preset = PresetAdjustments.merged(sampled, applying: [key: .number(6000)]).model
      XCTAssertEqual(preset.wbSource, .preset)
      assertNoDerivation(preset)
    }
    let samePair = PresetAdjustments.merged(sampled, applying: ["temperature": .number(5300)]).model
    XCTAssertEqual(samePair.wbSource, .preset)
    assertNoDerivation(samePair)
  }

  func testPresetSourceTravelsButDerivationDoesNot() {
    let preset = PresetAdjustments.merged(
      sampled,
      applying: [
        "temperature": .number(6000), "wb_source": .string("Sampled"),
      ]
    ).model
    XCTAssertEqual(preset.wbSource, .sampled)
    assertNoDerivation(preset)
  }

  func testPresetsWithoutValidWhiteBalanceFieldsPreserveProvenance() {
    for fields: [String: PresetFieldValue] in [
      ["exposure": .number(2)], ["temperature": .number(.nan)],
      ["tint": .string("bad")], ["wb_source": .string("Unknown")],
    ] {
      let preset = PresetAdjustments.merged(sampled, applying: fields).model
      XCTAssertEqual(preset.wbSource, .sampled)
      XCTAssertEqual(preset.wbSampleX, sampled.wbSampleX)
      XCTAssertEqual(preset.wbSampleY, sampled.wbSampleY)
      XCTAssertEqual(preset.wbAlgorithmVersion, 1)
    }
  }

  private func assertNoDerivation(_ model: AdjustmentModel) {
    XCTAssertEqual(model.wbSampleX, 0)
    XCTAssertEqual(model.wbSampleY, 0)
    XCTAssertEqual(model.wbAlgorithmVersion, 0)
  }
}
