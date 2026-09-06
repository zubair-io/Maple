import XCTest

@testable import MapleCore

@MainActor
final class WhiteBalancePresetTests: XCTestCase {
  func testLiveWhiteBalanceModesShareTheSameDecodedImageCacheKey() {
    let decoded = RawCoreBridge.stripAppleGPUStages(.default)
    for preset in WhiteBalancePreset.allCases {
      var live = AdjustmentModel.default
      live.whiteBalancePreset = preset
      live.temperature = 5100
      live.tint = -8
      live.wbSource = preset == .auto ? .auto : .preset
      live.wbScaleVersion = 1
      live.wbSampleX = 0.3
      live.wbSampleY = 0.8
      live.wbAlgorithmVersion = 3
      XCTAssertEqual(RawCoreBridge.stripAppleGPUStages(live), decoded)
      XCTAssertEqual(live.whiteBalancePreset, preset, "Stripping must not alter the live model")
    }
  }

  func testEveryNamedPresetIsOneUndoableEditAndSurvivesRealSidecar() async throws {
    for preset in WhiteBalancePreset.allCases where preset.pair != nil {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let raw = directory.appendingPathComponent("original.dng")
      var before = AdjustmentModel.default
      before.exposure = 1.5
      before.wbSource = .sampled
      before.wbSampleX = 0.4
      before.wbSampleY = 0.7
      before.wbAlgorithmVersion = 9
      before.wbScaleVersion = 1
      let session = EditSession(asset: AssetRef(url: raw), model: before)
      let state = EditorState(session: session)
      await state.applyWhiteBalancePreset(preset)
      let applied = session.model
      XCTAssertEqual(applied.temperature, preset.pair?.temperature)
      XCTAssertEqual(applied.tint, preset.pair?.tint)
      XCTAssertEqual(applied.whiteBalancePreset, preset)
      XCTAssertEqual(applied.wbSource, .preset)
      XCTAssertEqual(applied.wbScaleVersion, 5)
      XCTAssertEqual(applied.wbSampleX, 0)
      XCTAssertEqual(applied.wbSampleY, 0)
      XCTAssertEqual(applied.wbAlgorithmVersion, 0)
      XCTAssertEqual(applied.exposure, before.exposure)
      let decodeXML = XMPSerializer.serialize(
        model: applied, culling: CullingState(), omitWhiteBalance: true)
      XCTAssertFalse(
        decodeXML.contains("crs:WhiteBalance"),
        "Decode must not bake a named preset before the live WB pass")
      XCTAssertFalse(decodeXML.contains("crs:Temperature"))
      XCTAssertEqual(session.undoHistory.count, 1)
      let store = XMPSidecarStore(rawURL: raw)
      await store.update(model: applied, culling: CullingState())
      await store.flush()
      let reopened = XMPSidecarStore(rawURL: raw)
      let (loaded, _) = try await reopened.load()
      XCTAssertEqual(loaded, applied)
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: raw.path), "An edit must never create an original")
      state.undo()
      XCTAssertEqual(session.model, before)
      state.redo()
      XCTAssertEqual(session.model, applied)
      await session.releaseTransientMemory()
    }
  }

  func testCustomKeepsLegacyPairAndAsShotRestoresCameraReading() async {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    session.model.temperature = 5100
    session.model.tint = -8
    session.model.wbScaleVersion = 1
    session.asShotCCT = 5300
    session.asShotTint = 6
    await state.applyWhiteBalancePreset(.custom)
    XCTAssertEqual(session.model.temperature, 5100)
    XCTAssertEqual(session.model.tint, -8)
    XCTAssertEqual(session.model.wbScaleVersion, 1)
    XCTAssertEqual(session.model.wbSource, .manual)
    await state.applyWhiteBalancePreset(.asShot)
    XCTAssertEqual(session.model.temperature, 5300)
    XCTAssertEqual(session.model.tint, 6)
    XCTAssertEqual(session.model.whiteBalancePreset, .asShot)
    XCTAssertEqual(session.model.wbSource, .asShot)
    XCTAssertEqual(session.model.wbScaleVersion, 5)
    await session.releaseTransientMemory()
  }

  func testPickerAutoChangesOnlyWBAndRejectsNonfiniteResult() async {
    let session = EditSession(asset: AssetRef(url: URL(fileURLWithPath: "/tmp/auto-wb.dng")))
    let state = EditorState(session: session)
    session.model.exposure = 2
    session.model.contrast = 13
    let before = session.model
    state.autoProvider = { _ in
      AutoAdjustmentsResult(
        exposure: -1, temperature: 5800, tint: 5,
        contrast: 99, highlights: -20, shadows: 30, whites: 40, blacks: -50)
    }
    await state.applyWhiteBalancePreset(.auto)
    XCTAssertEqual(session.model.temperature, 5800)
    XCTAssertEqual(session.model.tint, 5)
    XCTAssertEqual(session.model.exposure, before.exposure)
    XCTAssertEqual(session.model.contrast, before.contrast)
    XCTAssertEqual(session.model.autoExposure, before.autoExposure)
    XCTAssertEqual(session.model.wbSource, .auto)
    XCTAssertEqual(session.model.whiteBalancePreset, .auto)
    XCTAssertEqual(session.model.wbAlgorithmVersion, autoWhiteBalanceAlgorithmVersion)
    state.undo()
    XCTAssertEqual(session.model, before)
    state.autoProvider = { _ in
      AutoAdjustmentsResult(
        exposure: 0, temperature: .nan, tint: 0,
        contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0)
    }
    await state.applyAuto()
    XCTAssertEqual(session.model, before)
    XCTAssertTrue(state.canRedo)
    await session.releaseTransientMemory()
  }

  func testForeignNamedPresetAndExplicitPairPrecedence() throws {
    for preset in WhiteBalancePreset.allCases where preset.pair != nil {
      func xml(_ attrs: String) -> String {
        """
        <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" \(attrs)/></rdf:RDF></x:xmpmeta>
        """
      }
      let name = #"crs:WhiteBalance="\#(preset.rawValue)""#
      let (named, _) = try XMPParser.parse(xml(name))
      XCTAssertEqual(named.temperature, preset.pair?.temperature)
      XCTAssertEqual(named.tint, preset.pair?.tint)
      XCTAssertEqual(named.wbSource, .preset)
      XCTAssertEqual(named.whiteBalancePreset, preset)
      let explicit = #"crs:Temperature="5000" crs:Tint="-8""#
      for attrs in ["\(name) \(explicit)", "\(explicit) \(name)"] {
        let (model, _) = try XMPParser.parse(xml(attrs))
        XCTAssertEqual(model.temperature, 5000)
        XCTAssertEqual(model.tint, -8)
        XCTAssertEqual(model.whiteBalancePreset, preset)
      }
      let source = #"xmlns:papp="\#(XMPCanonical.pappNamespaceURI)" papp:WbSource="Manual""#
      for attrs in ["\(name) \(source)", "\(source) \(name)"] {
        let (model, _) = try XMPParser.parse(xml(attrs))
        XCTAssertEqual(model.wbSource, .manual, "An explicit source wins over the preset name")
      }
    }
  }

  func testOldJSONAndEveryPresetJSONRoundTrip() throws {
    let old = try JSONEncoder().encode(AdjustmentModel.default)
    XCTAssertFalse(String(decoding: old, as: UTF8.self).contains("namedWhiteBalancePreset"))
    XCTAssertEqual(try JSONDecoder().decode(AdjustmentModel.self, from: old), .default)
    for preset in WhiteBalancePreset.allCases {
      var model = AdjustmentModel.default
      model.whiteBalancePreset = preset
      let data = try JSONEncoder().encode(model)
      XCTAssertEqual(try JSONDecoder().decode(AdjustmentModel.self, from: data), model)
    }
  }
}
