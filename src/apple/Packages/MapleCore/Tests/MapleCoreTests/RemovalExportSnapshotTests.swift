import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class RemovalExportSnapshotTests: XCTestCase {
  private func fixture(_ name: String, _ ext: String) throws -> Data {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "removal/calibration"))
    return try Data(contentsOf: url)
  }

  private func pixels(_ image: CIImage) -> Data {
    let width = Int(image.extent.width)
    let height = Int(image.extent.height)
    var bytes = Data(count: width * height * 4)
    bytes.withUnsafeMutableBytes {
      CIContext().render(
        image, toBitmap: $0.baseAddress!, rowBytes: width * 4, bounds: image.extent,
        format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    }
    return bytes
  }

  func testColdAndWarmExportsUseLiveRemovalSnapshotBeforeAutosave() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("photo.dng")
    let source = try fixture("source", "dng")
    try source.write(to: raw)
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let savedXML = try fixture("saved", "xmp")
    try savedXML.write(to: sidecar)
    let assets = directory.appendingPathComponent(".maple/inpaint")
    try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
    for (name, ext, suffix) in [("mask", "mimf", "mask"), ("patch", "f16", "f16")] {
      let bytes = try fixture(name, ext)
      let digest = String(try RemovalBridge.digest(bytes).dropFirst(7))
      try bytes.write(to: assets.appendingPathComponent("\(digest).\(suffix)"))
    }
    var model = try XMPParser.parse(data: savedXML).0
    model.profile = .neutral
    model.autoExposure = .off
    model.exposure = 1.5
    let target = CGSize(width: 64, height: 64)
    let asset = AssetRef(url: raw)
    let pipeline = ImageEditPipeline()
    let decodedResult = await pipeline.decodeSceneLinearSized(
      asset: asset, targetSize: target, xmpPath: sidecar, quality: .amaze,
      profileOverride: .neutral, autoExposureOverride: .off)
    let decoded = try XCTUnwrap(decodedResult)
    let anchor = decoded.wbFrame.flatMap { frame -> ImageEditPipeline.AsShotWB? in
      guard frame.isPresent else { return nil }
      return .init(temperature: Double(frame.sceneCCT), tint: Double(frame.asShotTint))
    }
    let expected = pipeline.processSceneLinear(
      decoded: decoded.image, model: model, targetSize: target, asShot: anchor,
      decodedAtModel: model, noiseProfile: decoded.noiseProfile, iso: decoded.iso,
      wbFrame: decoded.wbFrame, whitesAnchorEv: decoded.whitesAnchorEv)
    let expectedPixels = pixels(expected)

    // On-disk scalar state is deliberately different from the immutable export
    // snapshot. Its cache contains a real original-only decode, not a mock.
    let originalXML = XMPSerializer.serialize(model: .default, culling: CullingState())
    try originalXML.write(to: sidecar, atomically: true, encoding: .utf8)
    let originalResult = await pipeline.decodeSceneLinearSized(
      asset: asset, targetSize: target, xmpPath: sidecar, quality: .amaze,
      profileOverride: .neutral, autoExposureOverride: .off)
    let original = try XCTUnwrap(originalResult)
    XCTAssertNotEqual(pixels(original.image), pixels(decoded.image))
    for warm in [false, true] {
      let actor = RenderActor(pipeline: ImageEditPipeline())
      if warm {
        await actor._testSeedDecodedCache(
          asset: asset, decoded: original.image, rawResolution: original.image.extent.size,
          bakedModel: RawCoreBridge.stripAppleGPUStages(.default), isFull: true,
          profile: .neutral, autoExposure: .off, whitesAnchorEv: original.whitesAnchorEv)
      }
      let actual = try await actor.renderForExport(
        asset: asset, model: model, asShot: anchor, targetSize: target, qualityOverride: .amaze)
      XCTAssertEqual(
        pixels(actual), expectedPixels,
        "Saved pixels must survive \(warm ? "warm" : "cold") snapshot export")
    }
    try FileManager.default.removeItem(at: assets)
    let actor = RenderActor(pipeline: ImageEditPipeline())
    do {
      _ = try await actor.renderForExport(
        asset: asset, model: model, asShot: anchor, targetSize: target, qualityOverride: .amaze)
      XCTFail("A missing accepted asset must fail instead of exporting the original")
    } catch { XCTAssertTrue(error is RenderError) }
    XCTAssertEqual(try Data(contentsOf: raw), source)
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), originalXML)
  }
}
