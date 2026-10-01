import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class PartialWhiteBalanceTests: XCTestCase {
  private let frame = WbSliderFrame(
    mCold: [0.89, -0.10, 0.08, -0.43, 1.21, 0.22, -0.03, 0.14, 0.76], cctCold: 2856,
    mWarm: [0.75, -0.06, -0.05, -0.43, 1.21, 0.22, -0.09, 0.23, 0.65], cctWarm: 6504,
    sceneCCT: 5520.125, asShotTint: -43.79)

  private func xml(_ attrs: String) -> String {
    """
    <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Custom" \(attrs)/></rdf:RDF></x:xmpmeta>
    """
  }

  func testRealSidecarsPreserveIndependentAxesAfterHydrationAndUnrelatedEdit() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("photo.xmp")
    for attrs in [
      #"crs:Temperature="8500""#, #"crs:Tint="40""#,
      #"crs:Temperature="6500""#, #"crs:Tint="0""#,
    ] {
      try xml(attrs).write(to: path, atomically: true, encoding: .utf8)
      let imported = try XMPParser.parse(data: Data(contentsOf: path)).0
      var hydrated = imported.hydratingPartialWhiteBalance(in: frame)
      let temperature = imported.partialWhiteBalance?.temperature ?? Double(frame.sceneCCT)
      let tint = imported.partialWhiteBalance?.tint ?? Double(frame.asShotTint)
      XCTAssertEqual(hydrated.temperature, temperature)
      XCTAssertEqual(hydrated.tint, tint)
      let cpu = PipelineRenderer.makeParams(from: hydrated, wbFrame: frame)
      let gpu = PipelineRenderer.makeGpuLiveParams(from: hydrated, wbFrame: frame)
      XCTAssertEqual(cpu.temperature, Float(temperature))
      XCTAssertEqual(cpu.tint, Float(tint))
      XCTAssertEqual(gpu.temperature, cpu.temperature)
      XCTAssertEqual(gpu.tint, cpu.tint)
      hydrated.exposure = 1.25
      try XMPSerializer.serialize(model: hydrated, culling: CullingState())
        .write(to: path, atomically: true, encoding: .utf8)
      let saved = try String(contentsOf: path, encoding: .utf8)
      XCTAssertTrue(saved.contains(attrs))
      XCTAssertFalse(
        saved.contains(attrs.contains("Temperature") ? "crs:Tint=" : "crs:Temperature="))
      XCTAssertEqual(try XMPParser.parse(saved).0.partialWhiteBalance, imported.partialWhiteBalance)
    }
  }

  func testExplicitDefaultsRemainBothAuthored() throws {
    let model = try XMPParser.parse(xml(#"crs:Temperature="6500" crs:Tint="0""#)).0
    XCTAssertNil(model.partialWhiteBalance)
    let saved = XMPSerializer.serialize(model: model, culling: CullingState())
    XCTAssertTrue(saved.contains(#"crs:Temperature="6500""#))
    XCTAssertTrue(saved.contains(#"crs:Tint="0""#))
    let params = PipelineRenderer.makeParams(from: model, wbFrame: frame)
    XCTAssertEqual(params.temperature, 6500)
    XCTAssertEqual(params.tint, 0)
  }

  func testLegacyPartialCoordinatesWaitForCameraAndPersistTheirOriginalScale() throws {
    for version in 2...4 {
      let attrs =
        #"crs:Temperature="8500" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:WbScaleVersion="\#(version)""#
      let imported = try XMPParser.parse(xml(attrs)).0
      XCTAssertEqual(imported.wbScaleVersion, version)
      let hydrated = imported.hydratingPartialWhiteBalance(in: frame)
      let pair = WbDngTemperature.authoredPairToV5(
        temperature: 8500, tint: Double(frame.asShotTint), version: version)
      XCTAssertEqual(hydrated.temperature, pair.0)
      XCTAssertEqual(hydrated.tint, pair.1)
      let saved = XMPSerializer.serialize(model: hydrated, culling: CullingState())
      XCTAssertTrue(saved.contains(#"papp:WbScaleVersion="\#(version)""#))
      XCTAssertTrue(saved.contains(#"crs:Temperature="8500""#))
      XCTAssertFalse(saved.contains("crs:Tint="))
      XCTAssertEqual(imported.hydratingPartialWhiteBalance(in: nil), imported)
    }
  }

  func testManualEditOfSameValueAuthorsTheDisplayedPairAndUndoRestoresImport() throws {
    let imported = try XMPParser.parse(xml(#"crs:Temperature="8500""#)).0
      .hydratingPartialWhiteBalance(in: frame)
    let session = EditSession.preview()
    session.model = imported
    session.originalModel = imported
    session.beginEdit(description: "White balance")
    ToolValueMapping.apply(8500, to: &session.model, tool: .temp)
    session.endEdit()
    XCTAssertNil(session.model.partialWhiteBalance)
    XCTAssertEqual(session.model.tint, Double(frame.asShotTint))
    session.undo()
    XCTAssertEqual(session.model.partialWhiteBalance, imported.partialWhiteBalance)
    session.redo()
    XCTAssertNil(session.model.partialWhiteBalance)
  }

  func testCodableSnapshotsKeepIntentAndOlderModelsRemainReadable() throws {
    let imported = try XMPParser.parse(xml(#"crs:Tint="0""#)).0
    let data = try JSONEncoder().encode(imported)
    XCTAssertEqual(try JSONDecoder().decode(AdjustmentModel.self, from: data), imported)
    var old = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    old.removeValue(forKey: "partialWhiteBalance")
    let oldData = try JSONSerialization.data(withJSONObject: old)
    XCTAssertNil(try JSONDecoder().decode(AdjustmentModel.self, from: oldData).partialWhiteBalance)
  }

  private var fixtureRoot: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("test-fixtures/batch-transfer")
  }

  func testColdRawResolutionPreservesOriginalAxesAndUsesActualCameraMetadata() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "partial-wb-cold")
    defer { try? FileManager.default.removeItem(at: root) }
    for name in ["source.dng", "target.dng"] {
      let raw = root.appendingPathComponent(name)
      try FileManager.default.copyItem(at: fixtureRoot.appendingPathComponent(name), to: raw)
      let bytes = try Data(contentsOf: raw)
      let decoded = try PipelineRenderer.renderSceneLinear(
        rawBytes: bytes, hint: "dng", quality: .full, profileOverride: .neutral)
      let actualFrame = try XCTUnwrap(decoded.wbFrame)
      XCTAssertTrue(actualFrame.isPresent)
      XCTAssertGreaterThan(abs(actualFrame.asShotTint), 0.5)
      for version in 1...5 {
        for axis in [
          #"crs:Temperature="8500""#, #"crs:Tint="40""#,
          #"crs:Temperature="6500""#, #"crs:Tint="0""#,
        ] {
          let sidecar = SidecarPath.sidecarURL(for: raw)
          let attrs =
            axis
            + #" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:WbScaleVersion="\#(version)""#
          try xml(attrs).write(to: sidecar, atomically: true, encoding: .utf8)
          let imported = try await XMPSidecarStore(rawURL: raw).load().0
          let resolved = try await ImportedWhiteBalanceResolver.resolve(
            asset: AssetRef(url: raw), model: imported)
          XCTAssertEqual(resolved.wbScaleVersion, 5)
          XCTAssertEqual(
            resolved.partialWhiteBalance?.temperature, imported.partialWhiteBalance?.temperature)
          XCTAssertEqual(resolved.partialWhiteBalance?.tint, imported.partialWhiteBalance?.tint)
          XCTAssertEqual(resolved.partialWhiteBalance?.version, version)
          let cpu = PipelineRenderer.makeParams(from: resolved, wbFrame: actualFrame)
          let gpu = PipelineRenderer.makeGpuLiveParams(from: resolved, wbFrame: actualFrame)
          XCTAssertEqual(cpu.temperature, gpu.temperature)
          XCTAssertEqual(cpu.tint, gpu.tint)
          if version == 5 {
            XCTAssertEqual(
              cpu.temperature,
              Float(imported.partialWhiteBalance?.temperature ?? Double(actualFrame.sceneCCT)))
            XCTAssertEqual(
              cpu.tint, Float(imported.partialWhiteBalance?.tint ?? Double(actualFrame.asShotTint)))
          }
          var edited = resolved
          edited.exposure = 1.25
          try await XMPSidecarStore(rawURL: raw).writeConfirmed(
            model: edited, culling: CullingState())
          let saved = try String(contentsOf: sidecar, encoding: .utf8)
          XCTAssertTrue(saved.contains(axis))
          XCTAssertFalse(
            saved.contains(axis.contains("Temperature") ? "crs:Tint=" : "crs:Temperature="))
          XCTAssertTrue(saved.contains(#"papp:WbScaleVersion="\#(version)""#))
        }
      }
      let remote = AssetRef(
        displayName: name, hintExtension: "dng", explicitIsRaw: true, bytesProvider: { bytes })
      let imported = try XMPParser.parse(xml(#"crs:Tint="40""#)).0
      let local = try await ImportedWhiteBalanceResolver.resolve(
        asset: AssetRef(url: raw), model: imported)
      let remoteResolved = try await ImportedWhiteBalanceResolver.resolve(
        asset: remote, model: imported)
      XCTAssertEqual(local, remoteResolved)
      XCTAssertEqual(try Data(contentsOf: raw), bytes)
    }
  }

  func testRealSessionLoadsPartialIntentAndUnrelatedSaveReopensWithoutAuthoringMissingAxis()
    async throws
  {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "partial-wb-session")
    defer { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("source.dng")
    try FileManager.default.copyItem(at: fixtureRoot.appendingPathComponent("source.dng"), to: raw)
    let originalBytes = try Data(contentsOf: raw)
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try xml(#"crs:Temperature="8500""#).write(to: sidecar, atomically: true, encoding: .utf8)
    let session = EditSession(asset: AssetRef(url: raw))
    await session.loadSidecar()
    XCTAssertTrue(session.hasLoadedSidecar)
    XCTAssertNil(session.renderError)
    XCTAssertNotEqual(session.model.tint, 0)
    XCTAssertNotNil(session.model.partialWhiteBalance?.resolvedTarget)
    session.beginEdit(description: "Exposure")
    session.model.exposure = 1.25
    session.endEdit()
    await session.flushPendingSidecarWrite()
    XCTAssertFalse(try String(contentsOf: sidecar, encoding: .utf8).contains("crs:Tint="))
    let reopened = EditSession(asset: AssetRef(url: raw))
    await reopened.loadSidecar()
    XCTAssertEqual(reopened.model, session.model)
    session.beginEdit(description: "White balance")
    ToolValueMapping.apply(session.model.temperature, to: &session.model, tool: .temp)
    session.endEdit()
    await session.flushPendingSidecarWrite()
    XCTAssertTrue(try String(contentsOf: sidecar, encoding: .utf8).contains("crs:Tint="))
    session.undo()
    await session.flushPendingSidecarWrite()
    XCTAssertFalse(try String(contentsOf: sidecar, encoding: .utf8).contains("crs:Tint="))
    XCTAssertEqual(try Data(contentsOf: raw), originalBytes)
  }

  func testSdrFallbackPreservesOriginalScaleWhileLivePairUsesEstablishedTintMagnitude() async throws
  {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "partial-wb-sdr")
    defer { try? FileManager.default.removeItem(at: root) }
    let png = root.appendingPathComponent("photo.png")
    let bytes = try SidecarContractIO.makeSyntheticOriginal(at: png)
    for version in 1...5 {
      let attrs =
        #"crs:Tint="40" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:WbScaleVersion="\#(version)""#
      let model = try XMPParser.parse(xml(attrs)).0
      let resolved = try await ImportedWhiteBalanceResolver.resolve(
        asset: AssetRef(url: png), model: model)
      XCTAssertEqual(resolved.temperature, 6500)
      XCTAssertEqual(resolved.tint, version == 2 ? -12 : version <= 3 ? 12 : 40, accuracy: 0.00001)
      let saved = XMPSerializer.serialize(model: resolved, culling: CullingState())
      XCTAssertFalse(saved.contains("crs:Temperature="))
      XCTAssertTrue(saved.contains(#"crs:Tint="40""#))
      XCTAssertTrue(saved.contains(#"papp:WbScaleVersion="\#(version)""#))
    }
    XCTAssertEqual(try Data(contentsOf: png), bytes)
  }

  func testUnreadableRawPreservesImportedFieldsAndReportsResolutionFailure() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "partial-wb-error")
    defer { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("broken.dng")
    try Data("not a RAW".utf8).write(to: raw)
    try xml(#"crs:Temperature="8500" crs:Exposure2012="1.25""#)
      .write(to: SidecarPath.sidecarURL(for: raw), atomically: true, encoding: .utf8)
    let session = EditSession(asset: AssetRef(url: raw))
    await session.loadSidecar()
    XCTAssertTrue(session.hasLoadedSidecar)
    XCTAssertNotNil(session.renderError)
    XCTAssertNotNil(session.partialWhiteBalanceImportError)
    XCTAssertNotNil(session.model.partialWhiteBalance)
    XCTAssertEqual(session.model.exposure, 1.25)
    let library = BatchAdjustmentLibrary(
      id: "test", resolve: { _ in AssetRef(url: raw) }, session: { _ in session },
      store: { _ in XMPSidecarStore(rawURL: raw) })
    do {
      _ = try await library.readModel(for: AssetRef(url: raw))
      XCTFail("Copy must report the unresolved camera axis")
    } catch { XCTAssertEqual((error as NSError).domain, "Maple.WhiteBalanceImport") }
  }

  func testPresetAutoAsShotSampleAndPasteReplacePartialIntentAndUndoRestoresRealSidecar()
    async throws
  {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "partial-wb-authors")
    defer { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("source.dng")
    try FileManager.default.copyItem(at: fixtureRoot.appendingPathComponent("source.dng"), to: raw)
    let bytes = try Data(contentsOf: raw)
    let sidecar = SidecarPath.sidecarURL(for: raw)
    for preset in [WhiteBalancePreset.custom, .daylight, .auto, .asShot] {
      try xml(#"crs:Temperature="8500""#).write(to: sidecar, atomically: true, encoding: .utf8)
      let session = EditSession(asset: AssetRef(url: raw))
      await session.loadSidecar()
      let before = session.model
      let editor = EditorState(session: session)
      editor.autoProvider = { _ in
        AutoAdjustmentsResult(
          exposure: 0, temperature: 5800, tint: 5,
          contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0)
      }
      await editor.applyWhiteBalancePreset(preset)
      XCTAssertNil(session.model.partialWhiteBalance, "\(preset)")
      await session.flushPendingSidecarWrite()
      XCTAssertTrue(try String(contentsOf: sidecar, encoding: .utf8).contains("crs:Tint="))
      editor.undo()
      XCTAssertEqual(session.model, before)
      await session.flushPendingSidecarWrite()
      XCTAssertFalse(try String(contentsOf: sidecar, encoding: .utf8).contains("crs:Tint="))
      await session.releaseTransientMemory()
    }
    let session = EditSession(asset: AssetRef(url: raw))
    await session.loadSidecar()
    let before = session.model
    let picker = WhiteBalancePicker(session: session)
    picker.provider = { _, _, _ in
      WhiteBalanceSample(temperature: 4820, tint: -12, algorithmVersion: 1)
    }
    picker.arm()
    await picker.pick(at: CGPoint(x: 0.25, y: 0.75))
    XCTAssertNil(session.model.partialWhiteBalance)
    XCTAssertEqual(session.model.wbScaleVersion, 5)
    await session.flushPendingSidecarWrite()
    XCTAssertTrue(try String(contentsOf: sidecar, encoding: .utf8).contains(#"crs:Tint="-12""#))
    session.undo()
    XCTAssertEqual(session.model, before)
    var source = before
    source.temperature = 6200
    source.tint = 9
    let patch = PreparedAdjustmentTransfer(
      model: source, groupIDs: [AdjustmentGroup.whiteBalance.rawValue], before: before)
    try await session.applyAdjustmentTransfer(patch)
    XCTAssertNil(session.model.partialWhiteBalance)
    XCTAssertEqual(session.model.temperature, 6200)
    XCTAssertEqual(session.model.tint, 9)
    XCTAssertTrue(try String(contentsOf: sidecar, encoding: .utf8).contains(#"crs:Tint="9""#))
    session.undo()
    XCTAssertEqual(session.model, before)
    await session.flushPendingSidecarWrite()
    XCTAssertFalse(try String(contentsOf: sidecar, encoding: .utf8).contains("crs:Tint="))
    XCTAssertEqual(try Data(contentsOf: raw), bytes)
    await session.releaseTransientMemory()
  }

}
