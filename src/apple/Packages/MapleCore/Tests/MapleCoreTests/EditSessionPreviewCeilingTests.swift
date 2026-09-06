import CoreImage
import Foundation
import Metal
import QuartzCore
import XCTest

@testable import MapleCore

/// #2217: exercise the real decodeAndRender branches, not just the target helper.
/// The Bayer fixture delivers 32² at Preview, then the native-canvas transform
/// expands it to 64². An uncapped downstream target therefore produces a
/// detectably oversized CPU image or GPU upload, even though decode was bounded.
@MainActor
final class EditSessionPreviewCeilingTests: XCTestCase {
  func testFreshRawCPUUsesDeliveredExtent() async throws {
    try await checkRawRender(cached: false, gpu: false)
  }

  func testCachedRawCPUUsesDeliveredExtent() async throws {
    try await checkRawRender(cached: true, gpu: false)
  }

  func testFreshRawGPUUsesDeliveredExtent() async throws {
    try await checkRawRender(cached: false, gpu: true)
  }

  func testCachedRawGPUUsesDeliveredExtent() async throws {
    try await checkRawRender(cached: true, gpu: true)
  }

  func testFreshNonRawCPUUsesPortraitDeliveredExtent() async throws {
    try await checkNonRawRender(cached: false)
  }

  func testCachedNonRawCPUUsesPortraitDeliveredExtent() async throws {
    try await checkNonRawRender(cached: true)
  }

  func testCachedCPUCompensatesCropBeforeCapping() async throws {
    try await checkCroppedRender(gpu: false)
  }

  func testCachedGPUKeepsUncompensatedCropTarget() async throws {
    try await checkCroppedRender(gpu: true)
  }

  func testFreshRawTargetBelowPreviewCeilingStaysSmall() async throws {
    let session = try makeRawSession()
    session.gpuLiveDriver = nil
    await session.decodeAndRender(targetSize: CGSize(width: 16, height: 16), phase: .fast)
    let snapshot = await session.renderActor.snapshot(forAsset: session.asset)
    XCTAssertEqual(snapshot.rawResolution, CGSize(width: 16, height: 16))
    XCTAssertEqual(try cpuExtent(session), CGSize(width: 16, height: 16))
  }

  private func checkRawRender(cached: Bool, gpu: Bool) async throws {
    let session = try makeRawSession()
    // Warm through sharedDecode itself: this records the real profile/AE keys
    // and the pre-normalization resolution, exactly as a completed open does.
    if cached { try await warmCache(session) }
    let before = await session.renderActor.snapshot(forAsset: session.asset)
    XCTAssertEqual(before.image != nil, cached)
    let layer = try configurePresentation(session, gpu: gpu)

    await session.decodeAndRender(targetSize: CGSize(width: 48, height: 48), phase: .fast)

    let after = await session.renderActor.snapshot(forAsset: session.asset)
    XCTAssertEqual(after.rawResolution, CGSize(width: 32, height: 32))
    XCTAssertEqual(after.image?.extent.size, CGSize(width: 64, height: 64))
    XCTAssertEqual(after.decodeGeneration, before.decodeGeneration + (cached ? 0 : 1))
    XCTAssertTrue(after.isFresh)
    let output = try await outputExtent(session, gpu: gpu)
    XCTAssertEqual(output, CGSize(width: 32, height: 32))
    await session.gpuLiveDriver?.closeSession()
    withExtendedLifetime(layer) {}
  }

  private func checkNonRawRender(cached: Bool) async throws {
    // Model a bytes-backed portrait proxy arriving after the original's native
    // size is known. The provider delivers a real 32×64 PNG; the canvas retains
    // its 64×128 coordinate space. This forces the defensive cap to matter on
    // processSceneLinearNonRaw too, without substituting a fake render function.
    let image = CIImage(color: CIColor(red: 0.2, green: 0.3, blue: 0.4))
      .cropped(to: CGRect(x: 0, y: 0, width: 32, height: 64))
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    let bytes = try XCTUnwrap(
      CIContext().pngRepresentation(of: image, format: .RGBA8, colorSpace: space))
    let session = EditSession(
      asset: AssetRef(displayName: "portrait-proxy.png", hintExtension: "png") { bytes },
      model: neutralModel())
    session.nativeImageSize = CGSize(width: 64, height: 128)
    session.gpuLiveDriver = nil
    if cached { try await warmCache(session) }
    let before = await session.renderActor.snapshot(forAsset: session.asset)
    XCTAssertEqual(before.image != nil, cached)

    await session.decodeAndRender(targetSize: CGSize(width: 48, height: 96), phase: .fast)

    let after = await session.renderActor.snapshot(forAsset: session.asset)
    XCTAssertEqual(after.rawResolution, CGSize(width: 32, height: 64))
    XCTAssertEqual(after.image?.extent.size, CGSize(width: 64, height: 128))
    XCTAssertEqual(after.decodeGeneration, before.decodeGeneration + (cached ? 0 : 1))
    XCTAssertEqual(try cpuExtent(session), CGSize(width: 32, height: 64))
  }

  private func checkCroppedRender(gpu: Bool) async throws {
    let crop = Crop(top: 0.25, left: 0.25, bottom: 0.75, right: 0.75)
    let session = try makeRawSession(crop: crop)
    try await warmCache(session)
    let before = await session.renderActor.snapshot(forAsset: session.asset)
    let layer = try configurePresentation(session, gpu: gpu)

    // CPU develops the full frame at 24² then crops to 12²; GPU crops the
    // native canvas first and must receive the original 12² canvas target.
    await session.decodeAndRender(targetSize: CGSize(width: 12, height: 12), phase: .fast)

    let after = await session.renderActor.snapshot(forAsset: session.asset)
    XCTAssertEqual(after.decodeGeneration, before.decodeGeneration)
    let output = try await outputExtent(session, gpu: gpu)
    XCTAssertEqual(output, CGSize(width: 12, height: 12))
    await session.gpuLiveDriver?.closeSession()
    withExtendedLifetime(layer) {}
  }

  private func makeRawSession(crop: Crop = .identity) throws -> EditSession {
    let appleRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let fixture = appleRoot.appendingPathComponent(
      "MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
    // This fixture is committed: absence is a broken checkout, not a skip.
    let bytes = try Data(contentsOf: fixture)
    let asset = AssetRef(displayName: "preview-ceiling.dng", hintExtension: "dng") { bytes }
    let session = EditSession(asset: asset, model: neutralModel(crop: crop))
    session.nativeImageSize = CGSize(width: 64, height: 64)
    return session
  }

  private func neutralModel(crop: Crop = .identity) -> AdjustmentModel {
    var model = AdjustmentModel.default
    model.profile = .neutral
    model.crop = crop
    return model
  }

  private func warmCache(_ session: EditSession) async throws {
    let decoded = await session.renderActor.sharedDecode(
      asset: session.asset, target: session.nativeImageSize,
      profile: session.model.profile, autoExposure: session.model.autoExposure,
      quality: .preview,
      normalize: { image, asset in
        await session.decodedForNativeCanvas(image, asset: asset)
      })
    XCTAssertNotNil(decoded)
  }

  private func configurePresentation(_ session: EditSession, gpu: Bool) throws -> CAMetalLayer? {
    guard gpu else {
      session.gpuLiveDriver = nil
      return nil
    }
    guard GpuLiveFlag.isEnabled, MTLCreateSystemDefaultDevice() != nil else {
      throw XCTSkip("GPU integration requires Metal and MAPLE_GPU_LIVE enabled")
    }
    let layer = CAMetalLayer()
    layer.bounds = CGRect(x: 0, y: 0, width: 64, height: 64)
    let driver = GpuLiveDriver()
    driver.register(layer: layer)
    session.gpuLiveDriver = driver
    return layer
  }

  private func outputExtent(_ session: EditSession, gpu: Bool) async throws -> CGSize {
    guard gpu else { return try cpuExtent(session) }
    XCTAssertNil(session.renderError)
    XCTAssertFalse(session.isRendering)
    XCTAssertTrue(session.gpuFramePresented, "GPU fallback must not make this test pass")
    XCTAssertFalse(session.gpuPresentFailed)
    XCTAssertNil(session.renderedPreview, "The GPU branch must bypass CPU publication")
    let driver = try XCTUnwrap(session.gpuLiveDriver)
    let anchor = session.wbDeltaAnchor
    let frame = await driver.renderCurrentFrameBytes(
      model: session.model, asShotCCT: anchor?.temperature, asShotTint: anchor?.tint,
      wbFrame: session.wbSliderFrame)
    let pixels = try XCTUnwrap(frame)
    XCTAssertEqual(pixels.bytes.count, pixels.width * pixels.height * 3)
    return CGSize(width: pixels.width, height: pixels.height)
  }

  private func cpuExtent(_ session: EditSession) throws -> CGSize {
    XCTAssertNil(session.renderError)
    XCTAssertFalse(session.isRendering)
    XCTAssertFalse(session.gpuFramePresented)
    XCTAssertTrue(session.previewIsFullRender)
    return try XCTUnwrap(session.renderedPreview).extent.size
  }
}
