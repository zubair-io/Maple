import CoreGraphics
import CoreImage
import Foundation
import XCTest

@testable import MapleCore

extension GpuLiveCpuP3ParityTests {
  @MainActor
  private func captureModel() -> AdjustmentModel {
    var model = AdjustmentModel.default
    model.sharpenAmount = 0
    model.nrColor = 0
    return model
  }

  @MainActor
  func testCapturedMetalPixelsAreManagedSRGBRegardlessOfCanvasSetting() async throws {
    let defaults = UserDefaults.standard
    let saved = defaults.object(forKey: CanvasColorSpace.defaultsKey)
    defer {
      if let saved {
        defaults.set(saved, forKey: CanvasColorSpace.defaultsKey)
      } else {
        defaults.removeObject(forKey: CanvasColorSpace.defaultsKey)
      }
    }
    let root = try SidecarContractIO.makeTempDirectory(prefix: "agent-capture-managed")
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("wide-gamut.png")
    let originalPixels: [Float] = (0..<32 * 24).flatMap { i in
      i % 2 == 0 ? [0.85, 0.12, 0.05, 1] : [0.04, 0.7, 0.9, 1]
    }
    let scene = CIImage(
      bitmapData: originalPixels.withUnsafeBufferPointer { Data(buffer: $0) },
      bytesPerRow: 32 * 16, size: CGSize(width: 32, height: 24), format: .RGBAf,
      colorSpace: CGColorSpace(name: CGColorSpace.displayP3))
    let linearSpace = try XCTUnwrap(CGColorSpace(name: CGColorSpace.displayP3))
    try CIContext().writePNGRepresentation(
      of: scene, to: url, format: .RGBA8, colorSpace: linearSpace)
    let original = try Data(contentsOf: url)
    defaults.set(CanvasColorSpace.displayP3.rawValue, forKey: CanvasColorSpace.defaultsKey)
    let session = EditSession(asset: AssetRef(url: url), model: captureModel())
    session.previewSize = CGSize(width: 32, height: 24)
    await session.openAssetPipelineAsync()
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    let snapshot = await session.renderActor.snapshot(forAsset: session.asset)
    let decoded = try XCTUnwrap(snapshot.image)
    let pipeline = ImageEditPipeline()
    let floats = try XCTUnwrap(
      pipeline.sceneLinearFloats(from: decoded, targetSize: CGSize(width: 32, height: 24)))
    let driver = GpuLiveDriver()
    try await driver.open(
      width: floats.width, height: floats.height, inputShape: 1,
      identity: GpuUploadIdentity(decodeGeneration: snapshot.decodeGeneration, crop: .identity)
    ) { floats.pixels }
    defer { Task { await driver.closeSession() } }
    defaults.set(CanvasColorSpace.srgb.rawValue, forKey: CanvasColorSpace.defaultsKey)
    let srgbFrame = await driver.renderCurrentFrameBytes(
      model: captureModel(), asShotCCT: 6500, asShotTint: 0)
    let srgb = try XCTUnwrap(srgbFrame)
    defaults.set(CanvasColorSpace.displayP3.rawValue, forKey: CanvasColorSpace.defaultsKey)
    let p3Frame = await driver.renderCurrentFrameBytes(
      model: captureModel(), asShotCCT: 6500, asShotTint: 0)
    let p3 = try XCTUnwrap(p3Frame)
    XCTAssertEqual(
      srgb.bytes, p3.bytes, "An sRGB captured frame must be independent of the canvas primaries.")
    let image = try XCTUnwrap(
      EditSession.ciImageFromGpuRgb(p3.bytes, width: p3.width, height: p3.height))
    let cpu = pipeline.processSceneLinearNonRaw(
      decoded: decoded, model: captureModel(),
      targetSize: CGSize(width: floats.width, height: floats.height), targetPrimariesOverride: .srgb
    )
    let actual = try AgentVectorscope.capturePixels(
      canvas: image, weights: nil, region: nil, context: CIContext())
    let expected = try AgentVectorscope.capturePixels(
      canvas: cpu, weights: nil, region: nil, context: CIContext())
    let captured = await session.agentCanvasSnapshot()
    let cpuCanvas = try XCTUnwrap(captured)
    let cpuCapture = try AgentVectorscope.capturePixels(
      canvas: cpuCanvas, weights: nil, region: nil, context: CIContext())
    XCTAssertEqual(actual.width, expected.width)
    XCTAssertEqual(actual.height, expected.height)
    XCTAssertEqual(actual.rgba.count, cpuCapture.rgba.count)
    let worst = zip(actual.rgba, expected.rgba).map { abs(Int($0) - Int($1)) }.max() ?? 0
    let captureWorst = zip(actual.rgba, cpuCapture.rgba).map { abs(Int($0) - Int($1)) }.max() ?? 0
    XCTAssertLessThanOrEqual(worst, 2, "Actual Metal capture must match the shared sRGB CPU chain.")
    XCTAssertLessThanOrEqual(
      captureWorst, 2, "Actual P3-canvas CPU inspector capture must match Metal sRGB capture.")
    XCTAssertEqual(try Data(contentsOf: url), original)
  }
  @MainActor
  func testCanonicalRawAutoFilmAndCropCaptureMatchesActualDevelop() async throws {
    let repo = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
    let url = repo.appendingPathComponent("test-fixtures/raws/test_0000.DNG")
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw XCTSkip("Physical RAW fixture absent")
    }
    let root = try SidecarContractIO.makeTempDirectory(prefix: "agent-raw-capture-tail")
    defer { try? FileManager.default.removeItem(at: root) }
    let owned = root.appendingPathComponent("source.DNG")
    try FileManager.default.copyItem(at: url, to: owned)
    let before = try Data(contentsOf: owned)
    let saved = UserDefaults.standard.object(forKey: CanvasColorSpace.defaultsKey)
    defer {
      if let saved {
        UserDefaults.standard.set(saved, forKey: CanvasColorSpace.defaultsKey)
      } else {
        UserDefaults.standard.removeObject(forKey: CanvasColorSpace.defaultsKey)
      }
    }
    UserDefaults.standard.set(
      CanvasColorSpace.displayP3.rawValue, forKey: CanvasColorSpace.defaultsKey)
    var model = captureModel()
    model.filmLook = "test_lut"
    model.filmStrength = 70
    model.crop = Crop(top: 0.125, left: 0.125, bottom: 0.875, right: 0.875, angle: 3)
    let session = EditSession(
      asset: AssetRef(url: owned), model: model,
      filmLutStore: FilmLutStore(bundle: .module))
    session.previewSize = CGSize(width: 128, height: 96)
    await session.openAssetPipelineAsync()
    session.createWholeImageSkinMask()
    await session.flushPendingSidecarWrite()
    session._scheduleRender(phase: .fast)
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    let rendered = try XCTUnwrap(session.renderedPreview)
    let maskID = try XCTUnwrap(session.selectedMaskId)
    let frame = try await session.agentCPUFrame(maskID: maskID)
    let context = CIContext()
    let expected = try AgentVectorscope.capturePixels(
      canvas: rendered, weights: nil,
      region: nil, context: context)
    let captured = try AgentVectorscope.capturePixels(
      canvas: frame.canvas, weights: nil,
      region: nil, context: context)
    XCTAssertEqual(captured.width, expected.width)
    XCTAssertEqual(captured.height, expected.height)
    XCTAssertEqual(captured.rgba.count, expected.rgba.count)
    let worst = zip(captured.rgba, expected.rgba).map { abs(Int($0) - Int($1)) }.max() ?? 0
    XCTAssertLessThanOrEqual(
      worst, 2, "Canonical capture must preserve actual Auto/film/crop develop.")
    XCTAssertNotNil(frame.weights)
    XCTAssertEqual(try Data(contentsOf: owned), before)
  }

}
