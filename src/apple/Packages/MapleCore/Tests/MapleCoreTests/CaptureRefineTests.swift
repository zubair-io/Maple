// CaptureRefineTests.swift — the GPU capture refine on Apple (#5381): the
// sized decode keeps a refine base, a refine to new chroma prefilter / deep
// denoise / capture-sharpening values matches a fresh decode, anything else
// declines, a cancelled refine publishes nothing, and the live driver
// replaces a same-size re-decode in place.

import Foundation
import RawPipeline
import XCTest

@testable import MapleCore

#if os(iOS)
  import UIKit
#endif

final class CaptureRefineTests: XCTestCase {
  private static let edge: UInt32 = 384

  private func fixture() throws -> URL {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("test-fixtures/raws/test_0007.DNG")
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw XCTSkip("RAW fixture missing: \(url.path)")
    }
    return url
  }

  private func sidecar(_ model: AdjustmentModel) throws -> URL {
    try XCTUnwrap(RawCoreBridge.writeStrippedModelXMP(model))
  }

  private func decode(_ raw: URL, _ model: AdjustmentModel) throws -> MapleSceneLinearImageData {
    let xmp = try sidecar(model)
    defer { try? FileManager.default.removeItem(at: xmp) }
    return try PipelineRenderer.renderSceneLinearSized(
      rawPath: raw, xmpPath: xmp, maxLongEdge: Self.edge)
  }

  private func refine(_ base: CaptureBase, _ model: AdjustmentModel, cancel: CancelFlag? = nil)
    throws -> MapleSceneLinearImageData?
  {
    let xmp = try sidecar(model)
    defer { try? FileManager.default.removeItem(at: xmp) }
    return try PipelineRenderer.refineCapture(base: base, xmpPath: xmp, cancel: cancel)
  }

  private func floats(_ data: MapleSceneLinearImageData) -> [Float] {
    data.pixels.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
  }

  private var denoised: AdjustmentModel {
    var model = AdjustmentModel()
    model.chromaPrefilter = 60
    model.deepDenoise = 40
    model.captureSharpeningAmount = 80
    return model
  }

  func testARefineFromTheBaseMatchesAFreshDecode() throws {
    let raw = try fixture()
    let first = try decode(raw, AdjustmentModel())
    let base = try XCTUnwrap(first.captureBase, "the sized decode keeps its refine base")
    let refined = try XCTUnwrap(try refine(base, denoised))
    let fresh = try decode(raw, denoised)
    XCTAssertEqual(refined.width, fresh.width)
    XCTAssertEqual(refined.height, fresh.height)
    XCTAssertNotNil(refined.captureBase, "a refine keeps the base for the next one")
    let (a, b) = (floats(refined), floats(fresh))
    let worst = zip(a, b).map { abs($0 - $1) / max(abs($1), 1) }.max() ?? 0
    XCTAssertLessThanOrEqual(worst, 1e-2, "the S0 GPU/CPU bound")
    XCTAssertNotEqual(a, floats(first), "the refine changed the capture")
    XCTAssertEqual(refined.aeGain, fresh.aeGain, accuracy: 1e-4 * fresh.aeGain)
  }

  func testARefineDeclinesAnEditBeyondTheRefinableStages() throws {
    let raw = try fixture()
    let base = try XCTUnwrap(try decode(raw, AdjustmentModel()).captureBase)
    var retouched = denoised
    retouched.retouchSpots = [
      RetouchSpot(
        kind: .heal, center: RetouchPoint(x: 0.4, y: 0.4), source: RetouchPoint(x: 0.6, y: 0.6))
    ]
    XCTAssertNil(try refine(base, retouched), "retouch stays on the CPU capture path")
    let phone = MapleCaptureRefineBudget(max_long_edge: Self.edge - 1, bm3d_binding_cap_bytes: 0)
    let xmp = try sidecar(denoised)
    defer { try? FileManager.default.removeItem(at: xmp) }
    XCTAssertNil(try PipelineRenderer.refineCapture(base: base, xmpPath: xmp, budget: phone))
  }

  func testACancelledRefinePublishesNothing() throws {
    let raw = try fixture()
    let base = try XCTUnwrap(try decode(raw, AdjustmentModel()).captureBase)
    let cancel = CancelFlag()
    cancel.requestCancel()
    XCTAssertThrowsError(try refine(base, denoised, cancel: cancel)) { error in
      guard case PipelineError.cancelled = error else {
        return XCTFail("expected cancellation, got \(error)")
      }
    }
  }

  func testTheDecodedCacheRefinesACaptureStageEditFromItsBase() async throws {
    let raw = try fixture()
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let copy = dir.appendingPathComponent(raw.lastPathComponent)
    try FileManager.default.copyItem(at: raw, to: copy)
    let asset = AssetRef(url: copy)
    let actor = RenderActor(pipeline: ImageEditPipeline())
    /// Decode `model` at `target` and return the cached base afterwards.
    func decode(_ model: AdjustmentModel, _ target: CGSize) async throws -> CaptureBase {
      let image = await actor.sharedDecode(
        asset: asset, target: target, profile: .neutral, autoExposure: .on,
        liveModel: model, normalize: { image, _ in image })
      XCTAssertNotNil(image)
      let cached = await actor.decodedCaptureBase
      return try XCTUnwrap(cached?.base)
    }
    let target = CGSize(width: 384, height: 256)
    let base = try await decode(AdjustmentModel(), target)
    let refinedBase = try await decode(denoised, target)
    XCTAssertTrue(refinedBase === base, "the edit refined from the cached base")

    var retouched = denoised
    retouched.retouchSpots = [
      RetouchSpot(
        kind: .heal, center: RetouchPoint(x: 0.4, y: 0.4), source: RetouchPoint(x: 0.6, y: 0.6))
    ]
    let redeveloped = try await decode(retouched, target)
    XCTAssertFalse(redeveloped === base, "a retouch edit re-develops on the CPU")

    var sharper = retouched
    sharper.captureSharpeningAmount = 40
    let resized = try await decode(sharper, CGSize(width: 480, height: 320))
    XCTAssertFalse(resized === redeveloped, "a decode at another size re-develops")
  }

  func testTheIPhoneClampOnlyAppliesWhileARefinableStageIsEngaged() async {
    let target = CGSize(width: 1206, height: 2400)
    let plain = await CaptureRefineBudget.clampedDecodeTarget(
      model: AdjustmentModel(), isRaw: true, target: target)
    XCTAssertEqual(plain, target)
    let clamped = await CaptureRefineBudget.clampedDecodeTarget(
      model: denoised, isRaw: true, target: target)
    #if os(iOS)
      if await UIDevice.current.userInterfaceIdiom == .phone {
        XCTAssertEqual(clamped?.height ?? 0, 1536, accuracy: 0.5)
        return
      }
    #endif
    XCTAssertEqual(clamped, target)
  }

  @MainActor
  func testTheDriverReplacesASameSizeReDecodeInPlace() async throws {
    let (w, h) = (32, 24)
    let before: [Float] = (0..<(w * h)).flatMap { i -> [Float] in
      [Float(i % w) / Float(w), 0.3, 0.2, 1]
    }
    let after: [Float] = before.enumerated().map { $0.offset % 4 == 3 ? 1 : $0.element * 0.5 }
    let driver = GpuLiveDriver()
    let first = GpuUploadIdentity(decodeGeneration: 1, crop: .identity)
    let second = GpuUploadIdentity(decodeGeneration: 2, crop: .identity)
    try await driver.open(width: w, height: h, identity: first, pixels: { before })
    let opened = try XCTUnwrap(driver.session)
    try await driver.open(width: w, height: h, identity: second, pixels: { after })
    XCTAssertTrue(driver.session === opened, "a same-size re-decode keeps the session")
    XCTAssertTrue(driver.isOpen(coveringWidth: w, height: h, identity: second))
    let model = AdjustmentModel()
    let replacedFrame = await driver.renderCurrentFrameBytes(model: model)
    let replaced = try XCTUnwrap(replacedFrame)

    let fresh = GpuLiveDriver()
    try await fresh.open(width: w, height: h, identity: second, pixels: { after })
    let reopenedFrame = await fresh.renderCurrentFrameBytes(model: model)
    let reopened = try XCTUnwrap(reopenedFrame)
    XCTAssertEqual(replaced.bytes, reopened.bytes)

    try await driver.open(
      width: w, height: h + 2, identity: first,
      pixels: {
        Array(repeating: 0.5, count: w * (h + 2) * 4)
      })
    XCTAssertFalse(driver.session === opened, "a size change still reopens")
    await driver.closeSession()
    await fresh.closeSession()
  }
}
