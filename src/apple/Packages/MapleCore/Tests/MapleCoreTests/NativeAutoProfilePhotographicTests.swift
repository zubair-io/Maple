import CoreImage
import Foundation
import RawPipeline
import XCTest

@testable import MapleCore

@MainActor
final class NativeAutoProfilePhotographicTests: XCTestCase {
  /// #1472: main's canonical inspector must consume the same settled native
  /// Auto tail as a saved-removal canvas, retaining independent mask coverage.
  func testCanonicalCaptureMatchesSettledSavedRemovalCPUCanvas() async throws {
    let corpus = AutoProfileCanvasParityTests.fixtureDir("test-fixtures/raws/removal-photographic")
    let source = corpus.appendingPathComponent("portrait.dng")
    guard FileManager.default.fileExists(atPath: source.path) else {
      throw XCTSkip("39MP photographic RAW absent (#1472)")
    }
    let original = try SidecarContractIO.sha256(of: source)
    XCTAssertEqual(original, "4a4154b2595dc76a7d5e10cdcb65a386319e31647a585c23e262fe62b969c0fe")
    let sidecar = try Data(contentsOf: corpus.appendingPathComponent("portrait.xmp"))
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "canonical-removal-auto")
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("portrait.dng")
    try FileManager.default.copyItem(at: source, to: raw)
    try FileManager.default.copyItem(
      at: corpus.appendingPathComponent(".maple"), to: directory.appendingPathComponent(".maple"))
    try sidecar.write(to: SidecarPath.sidecarURL(for: raw))
    var model = try XMPParser.parse(data: sidecar).0
    XCTAssertNotNil(model.inpaintRemovals)
    model.profile = .auto
    model.sharpenAmount = 0
    model.nrColor = 0
    model.filmLook = "test_lut"
    model.filmStrength = 70
    model.crop = Crop(top: 0.125, left: 0.125, bottom: 0.875, right: 0.875, angle: 3)
    let session = EditSession(
      asset: AssetRef(url: raw), model: model, filmLutStore: FilmLutStore(bundle: .module))
    // Exercise the real CPU fallback, not a synthetic raster or mocked sidecar.
    session.gpuPresentFailed = true
    session.previewSize = CGSize(width: 256, height: 192)
    session.createWholeImageSkinMask()
    await session.flushPendingSidecarWrite()
    session._scheduleRender(phase: .fast)
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    await session.nativeAutoProfile.awaitPreparation()
    let prepared = try XCTUnwrap(session.nativeAutoProfile.ready)
    XCTAssertNotNil(prepared.artifacts, "An absent/provisional Auto fit is not this regression")
    session._scheduleRender(phase: .fast)
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    XCTAssertTrue(session.hasSettledCPUAutoProfile)
    XCTAssertEqual(session.nativeAutoFrameID, prepared.id)
    let displayed = try XCTUnwrap(session.renderedPreview)
    let maskID = try XCTUnwrap(session.selectedMaskId)
    let frame = try await session.agentCPUFrame(maskID: maskID)
    let context = CIContext()
    let expected = try AgentVectorscope.capturePixels(
      canvas: displayed, weights: nil, region: nil, context: context)
    let captured = try AgentVectorscope.capturePixels(
      canvas: frame.canvas, weights: nil, region: nil, context: context)
    XCTAssertEqual(captured.width, expected.width)
    XCTAssertEqual(captured.height, expected.height)
    XCTAssertEqual(captured.rgba.count, expected.rgba.count)
    let worst = zip(captured.rgba, expected.rgba).map { abs(Int($0) - Int($1)) }.max() ?? 0
    XCTAssertLessThanOrEqual(worst, 2, "Settled native Auto/film/crop canvas and capture differ")
    XCTAssertNotNil(frame.weights)
    print("MAPLE_CANONICAL_SAVED_NATIVE_AUTO max=\(worst) lanes=\(captured.rgba.count)")
    await session.nativeAutoProfile.cancelAndWait()
    XCTAssertEqual(try SidecarContractIO.sha256(of: raw), original)
    XCTAssertEqual(try SidecarContractIO.sha256(of: source), original)
    XCTAssertEqual(try Data(contentsOf: corpus.appendingPathComponent("portrait.xmp")), sidecar)
  }

  func testProductionNativeArtifactsAndMetalMatchOriginalAndAcceptedPhoto() async throws {
    let corpus = AutoProfileCanvasParityTests.fixtureDir("test-fixtures/raws/removal-photographic")
    let source = corpus.appendingPathComponent("portrait.dng")
    guard FileManager.default.fileExists(atPath: source.path) else {
      throw XCTSkip("39MP photographic RAW absent (#1472)")
    }
    XCTAssertEqual(
      try SidecarContractIO.sha256(of: source),
      "4a4154b2595dc76a7d5e10cdcb65a386319e31647a585c23e262fe62b969c0fe")
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "production-native-auto")
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("portrait.dng")
    try FileManager.default.copyItem(at: source, to: raw)
    try FileManager.default.copyItem(
      at: corpus.appendingPathComponent(".maple"),
      to: directory.appendingPathComponent(".maple"))
    let originalXMP = try Data(contentsOf: corpus.appendingPathComponent("portrait.xmp"))
    let saved = try XMPParser.parse(data: originalXMP).0
    XCTAssertNotNil(saved.inpaintRemovals)
    let preparation = NativeAutoProfilePreparation()
    // Join a real native fit. Withdrawing one lease must not cancel the fit
    // another editor still needs; no model/sidecar I/O is mocked here.
    let cancelled = Task {
      try await preparation.prepare(url: raw, scope: directory, quality: .amaze)
    }
    let survivor = Task {
      try await preparation.prepare(url: raw, scope: directory, quality: .amaze)
    }
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while await preparation._testActiveWaiterCount() < 2, ContinuousClock.now < deadline {
      await Task.yield()
    }
    let waiters = await preparation._testActiveWaiterCount()
    XCTAssertEqual(waiters, 2)
    cancelled.cancel()
    do {
      _ = try await cancelled.value
      XCTFail("Cancelled waiter published")
    } catch is CancellationError {}  // Survivor still holds a lease.
    let prepared = try await survivor.value
    let artifacts = try XCTUnwrap(prepared.artifacts)
    let digest = { (values: [Float]) throws in
      try RemovalBridge.digest(values.withUnsafeBytes { Data($0) })
    }
    XCTAssertEqual(
      try digest(try XCTUnwrap(artifacts.curveFlat)),
      "blake3:36fe333ed9a0f35f60f700c055b19bf24ed4f6d80bb884d7c64cce7204bf85e7")
    XCTAssertEqual(
      try digest(try XCTUnwrap(artifacts.lutData)),
      // Main now defaults to Auto 2.0 (#1740); this is its AMaZE Render(None) LUT.
      "blake3:fba080fb7cfac464a51bd7e40466665ec90ba8eb8511cb8e6b9d9a59b5b06e30")
    let setting = UserDefaults.standard.object(forKey: CanvasColorSpace.defaultsKey)
    UserDefaults.standard.set(CanvasColorSpace.srgb.rawValue, forKey: CanvasColorSpace.defaultsKey)
    defer { UserDefaults.standard.set(setting, forKey: CanvasColorSpace.defaultsKey) }
    for accepted in [false, true] {
      var model = saved
      model.profile = .auto
      if !accepted { model.inpaintRemovals = nil }
      let xmp = SidecarPath.sidecarURL(for: raw)
      try XMPSerializer.serialize(model: model, culling: CullingState())
        .write(to: xmp, atomically: true, encoding: .utf8)
      let reference = try PipelineRenderer.render(rawPath: raw, xmpPath: xmp, quality: .amaze)
      let pipeline = ImageEditPipeline()
      let result = await pipeline.decodeSceneLinear(
        asset: AssetRef(url: raw), quality: .amaze, xmpPath: xmp,
        profileOverride: .auto, autoExposureOverride: model.autoExposure)
      let decoded = try XCTUnwrap(result)
      let floats = try XCTUnwrap(pipeline.sceneLinearFloats(from: decoded.image, targetSize: nil))
      let live = try GpuLiveSession(
        pixels: floats.pixels, width: floats.width, height: floats.height,
        noiseProfile: decoded.noiseProfile, iso: decoded.iso, whitesAnchorEv: decoded.whitesAnchorEv
      )
      await live.setNativeAutoProfile(prepared)
      let anchor = decoded.wbFrame.flatMap { frame -> ImageEditPipeline.AsShotWB? in
        guard frame.isPresent else { return nil }
        return .init(temperature: Double(frame.sceneCCT), tint: Double(frame.asShotTint))
      }
      let maybeOutput = try await live.renderToBuffer(
        model: model, asShotCCT: anchor?.temperature, asShotTint: anchor?.tint,
        wbFrame: decoded.wbFrame)
      await live.close()
      let output = try XCTUnwrap(maybeOutput)
      XCTAssertEqual(output.count, reference.pixels.count)
      let stats = zip(output, reference.pixels).reduce((max: 0, over1: 0, sum: 0)) { s, pair in
        let delta = abs(Int(pair.0) - Int(pair.1))
        return (max(s.max, delta), s.over1 + (delta > 1 ? 1 : 0), s.sum + delta)
      }
      XCTAssertLessThanOrEqual(stats.max, 1)
      XCTAssertEqual(stats.over1, 0)
      let cpu = try pipeline.processSceneLinearWithAuto(
        decoded: decoded.image, model: model, targetSize: nil, asShot: anchor,
        profileLUT: nil, nativeAutoProfile: prepared, noiseProfile: decoded.noiseProfile,
        iso: decoded.iso,
        wbFrame: decoded.wbFrame, whitesAnchorEv: decoded.whitesAnchorEv,
        targetPrimariesOverride: .srgb)
      var rgba = Data(count: reference.width * reference.height * 4)
      rgba.withUnsafeMutableBytes {
        CIContext(options: [.workingFormat: CIFormat.RGBAf, .cacheIntermediates: false]).render(
          cpu, toBitmap: $0.baseAddress!, rowBytes: reference.width * 4,
          bounds: cpu.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
      }
      let cpuStats = rgba.withUnsafeBytes { bytes -> (max: Int, over1: Int, sum: Int) in
        let actual = bytes.bindMemory(to: UInt8.self)
        return reference.pixels.enumerated().reduce((max: 0, over1: 0, sum: 0)) { s, pair in
          let pixel = pair.offset / 3
          let channel = pair.offset % 3
          let delta = abs(Int(actual[pixel * 4 + channel]) - Int(pair.element))
          return (max(s.max, delta), s.over1 + (delta > 1 ? 1 : 0), s.sum + delta)
        }
      }
      XCTAssertLessThanOrEqual(cpuStats.max, 1, "Native CPU fallback must match shared RAW")
      XCTAssertEqual(cpuStats.over1, 0)
      print(
        "MAPLE_PRODUCTION_NATIVE_AUTO_CPU accepted=\(accepted) max=\(cpuStats.max) over1=\(cpuStats.over1) sum=\(cpuStats.sum) lanes=\(reference.pixels.count)"
      )
      let warm = try await preparation.prepare(url: raw, scope: directory, quality: .amaze)
      XCTAssertEqual(warm.id, prepared.id, "Accepted patches/live grade must not refit Auto")
      print(
        "MAPLE_PRODUCTION_NATIVE_AUTO accepted=\(accepted) max=\(stats.max) over1=\(stats.over1) sum=\(stats.sum) lanes=\(output.count)"
      )
    }
    XCTAssertEqual(
      try SidecarContractIO.sha256(of: source),
      "4a4154b2595dc76a7d5e10cdcb65a386319e31647a585c23e262fe62b969c0fe")
    XCTAssertEqual(try Data(contentsOf: corpus.appendingPathComponent("portrait.xmp")), originalXMP)
  }
}
