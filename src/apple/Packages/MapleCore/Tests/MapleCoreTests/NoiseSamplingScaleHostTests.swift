import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class NoiseSamplingScaleHostTests: XCTestCase {
  func testResamplingComposesDensityWithoutTreatingUpscaleAsMoreDetail() {
    let source = CGSize(width: 1600, height: 1067)
    let reduced = NoiseSamplingScale.reduced(
      0.25, from: source, to: CGSize(width: 800, height: 534))
    XCTAssertEqual(reduced, 0.125)
    XCTAssertEqual(NoiseSamplingScale.reduced(0.25, from: source, to: source), 0.25)
    XCTAssertEqual(
      NoiseSamplingScale.reduced(0.25, from: source, to: CGSize(width: 3200, height: 2134)),
      0.25)
    XCTAssertEqual(NoiseSamplingScale.reduced(.nan, from: source, to: source), 1)
    XCTAssertEqual(NoiseSamplingScale.reduced(0, from: source, to: source), 1)
  }

  func testSamplingDensityInvalidatesCachedChainOutput() {
    let assetID = UUID()
    let cache = SceneLinearChainCache()
    cache._testSetEnabled(true)
    let key: (Float) -> SceneLinearChainCache.Key = { scale in
      SceneLinearChainCache.make(
        assetID: assetID, model: .default,
        decodedTemperature: 6500, decodedTint: 0,
        skipAgX: false, width: 64, height: 64, nrSamplingScale: scale)
    }
    cache.put(key(0.25), CIImage(color: .white))
    XCTAssertNotNil(cache.get(key(0.25)))
    XCTAssertNil(cache.get(key(1)))
  }

  func testSnapshotRetainsSamplingDensityUntilInvalidation() async {
    let actor = RenderActor(pipeline: ImageEditPipeline())
    let asset = AssetRef(
      displayName: "sampling.dng", hintExtension: "dng", stableID: "sampling-density",
      explicitIsRaw: true, bytesProvider: { Data() })
    let image = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 8))
    await actor._testSeedDecodedCache(
      asset: asset, decoded: image, rawResolution: CGSize(width: 32, height: 32),
      nrSamplingScale: 0.25)
    let snapshot = await actor.snapshot(forAsset: asset)
    XCTAssertEqual(snapshot.nrSamplingScale, 0.25)
    await actor.invalidate()
    let cleared = await actor.snapshot(forAsset: asset)
    XCTAssertEqual(cleared.nrSamplingScale, 1)
  }

  func testCpuAndGpuParameterBuildersRetainSamplingDensity() {
    let cpu = PipelineRenderer.makeParams(from: .default, nrSamplingScale: 0.25)
    let gpu = PipelineRenderer.makeGpuLiveParams(from: .default, nrSamplingScale: 0.25)
    XCTAssertEqual(cpu.nr_sampling_scale, 0.25)
    XCTAssertEqual(gpu.nr_sampling_scale, 0.25)
    XCTAssertEqual(PipelineRenderer.makeParams(from: .default).nr_sampling_scale, 1)
    XCTAssertEqual(PipelineRenderer.makeGpuLiveParams(from: .default).nr_sampling_scale, 1)
  }

  func testCachedExportUsesSamplingDensity() async throws {
    let actor = RenderActor(pipeline: ImageEditPipeline())
    let asset = AssetRef(
      displayName: "cached-sampling.dng", hintExtension: "dng",
      stableID: "cached-sampling", explicitIsRaw: true,
      bytesProvider: { throw CocoaError(.fileReadUnknown) }
    )
    let size = CGSize(width: 32, height: 24)
    var pixels = [Float]()
    for i in 0..<(32 * 24) {
      let x = Float(i % 32)
      let y = Float(i / 32)
      pixels.append(contentsOf: [
        0.2 + 0.015 * sin(x * 1.7 + y),
        0.2 + 0.012 * cos(y * 2.1 - x),
        0.2 + 0.018 * sin(x * 0.7 + y * 1.3), 1,
      ])
    }
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020))
    let image = CIImage(
      bitmapData: pixels.withUnsafeBufferPointer { Data(buffer: $0) },
      bytesPerRow: 32 * 4 * MemoryLayout<Float>.size, size: size,
      format: .RGBAf, colorSpace: space
    )
    var model = AdjustmentModel.default
    model.profile = .neutral
    model.nrColor = 75
    let context = CIContext(options: [.workingColorSpace: space])
    var outputs = [[Float]]()
    for scale: Float in [0.25, 1] {
      await actor._testSeedDecodedCache(
        asset: asset, decoded: image, rawResolution: size,
        bakedModel: RawCoreBridge.stripAppleGPUStages(model),
        profile: model.profile, autoExposure: model.autoExposure,
        nrSamplingScale: scale
      )
      let exported = try await actor.renderForExport(
        asset: asset, model: model, asShot: nil, targetSize: size,
        qualityOverride: .preview
      )
      var output = [Float](repeating: 0, count: pixels.count)
      context.render(
        exported, toBitmap: &output, rowBytes: 32 * 4 * MemoryLayout<Float>.size,
        bounds: CGRect(origin: .zero, size: size), format: .RGBAf, colorSpace: space
      )
      outputs.append(output)
    }
    let maxDifference = zip(outputs[0], outputs[1]).map { abs($0 - $1) }.max() ?? 0
    XCTAssertGreaterThan(maxDifference, 0.00001, "Export must retain cached sampling density")
  }
}
