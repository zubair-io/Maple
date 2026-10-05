import CoreImage
import XCTest

@testable import MapleCore

extension EditSessionDecodedCacheTests {
  func testFirstGPUOnlySidecarPreservesActualDecodedBuffer() async throws {
    let fixture = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
      .appending(path: "MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("first-sidecar-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let originalBytes = try Data(contentsOf: fixture)
    let raw = directory.appendingPathComponent("photo.dng")
    try originalBytes.write(to: raw)
    let asset = AssetRef(url: raw)
    let sidecar = try XCTUnwrap(asset.sidecarURL)
    XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
    let actor = RenderActor(pipeline: ImageEditPipeline())
    let target = CGSize(width: 64, height: 64)

    let cold = await actor.sharedDecode(asset: asset, target: target) { image, _ in image }
    XCTAssertNotNil(cold, "The control must execute the real RAW native binding")
    let coldPixels = try sceneLinearPixels(XCTUnwrap(cold))
    let before = await actor._testDecodeGeneration()
    let coldSnapshot = await actor.snapshot(forAsset: asset)
    XCTAssertTrue(coldSnapshot.isFresh)
    XCTAssertGreaterThan(before, 0)

    var edited = AdjustmentModel.default
    edited.exposure = 1
    edited.temperature = 7200
    let xml = XMPSerializer.serialize(model: edited, culling: CullingState())
    try xml.write(to: sidecar, atomically: true, encoding: .utf8)
    let (persisted, _) = try XMPParser.parse(String(contentsOf: sidecar, encoding: .utf8))
    XCTAssertEqual(persisted.exposure, 1)
    XCTAssertEqual(persisted.temperature, 7200)
    XCTAssertEqual(
      RawCoreBridge.stripAppleGPUStages(persisted),
      RawCoreBridge.stripAppleGPUStages(.default),
      "The first saved fields must affect only the live chain, not the decoded prefix")

    let afterSave = await actor.snapshot(forAsset: asset)
    // Use the actual freshness boundary to decide whether production would
    // need another scene-linear native call; no seeded image or mock sidecar.
    if !afterSave.isFresh {
      let repeated = await actor.sharedDecode(asset: asset, target: target) { image, _ in image }
      XCTAssertNotNil(repeated)
      XCTAssertEqual(
        try sceneLinearPixels(XCTUnwrap(repeated)), coldPixels,
        "The redundant native prefix must be pixel-identical for GPU-only edits")
    }
    let after = await actor._testDecodeGeneration()
    XCTAssertTrue(afterSave.isFresh, "A first GPU-only sidecar must preserve cache freshness")
    XCTAssertEqual(
      before, after, "A first GPU-only sidecar must retain the decoded buffer identity")
    XCTAssertEqual(try Data(contentsOf: raw), originalBytes)
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), xml)
  }

  func testFirstBakedSidecarAndRemovalReplaceActualDecodedPixels() async throws {
    let fixture = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
      .appending(path: "test-fixtures/raws/test_0007.DNG")
    guard FileManager.default.fileExists(atPath: fixture.path) else {
      throw XCTSkip("Physical nonflat test_0007.DNG fixture is not present")
    }
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("baked-sidecar-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let originalBytes = try Data(contentsOf: fixture)
    let raw = directory.appendingPathComponent("photo.dng")
    try originalBytes.write(to: raw)
    let asset = AssetRef(url: raw)
    let sidecar = try XCTUnwrap(asset.sidecarURL)
    let actor = RenderActor(pipeline: ImageEditPipeline())
    let target = CGSize(width: 256, height: 256)
    let initial = await actor.sharedDecode(asset: asset, target: target) { image, _ in image }
    let initialPixels = try sceneLinearPixels(XCTUnwrap(initial))
    let initialGeneration = await actor._testDecodeGeneration()

    var bakedEdit = AdjustmentModel.default
    bakedEdit.captureSharpeningAmount = 100
    bakedEdit.captureSharpeningSigma = 2
    let xml = XMPSerializer.serialize(model: bakedEdit, culling: CullingState())
    try xml.write(to: sidecar, atomically: true, encoding: .utf8)
    let persisted = try XMPParser.parse(String(contentsOf: sidecar, encoding: .utf8)).0
    XCTAssertNotEqual(
      RawCoreBridge.stripAppleGPUStages(persisted),
      RawCoreBridge.stripAppleGPUStages(.default))
    let changedSnapshot = await actor.snapshot(forAsset: asset)
    XCTAssertFalse(changedSnapshot.isFresh, "First CPU-baked XMP must invalidate")
    let changed = await actor.sharedDecode(asset: asset, target: target) { image, _ in image }
    XCTAssertNotEqual(try sceneLinearPixels(XCTUnwrap(changed)), initialPixels)
    let changedGeneration = await actor._testDecodeGeneration()
    XCTAssertGreaterThan(changedGeneration, initialGeneration)
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), xml)

    try FileManager.default.removeItem(at: sidecar)
    let removedSnapshot = await actor.snapshot(forAsset: asset)
    XCTAssertFalse(removedSnapshot.isFresh, "Removing nondefault baked XMP must invalidate")
    let restored = await actor.sharedDecode(asset: asset, target: target) { image, _ in image }
    XCTAssertEqual(try sceneLinearPixels(XCTUnwrap(restored)), initialPixels)
    let restoredGeneration = await actor._testDecodeGeneration()
    XCTAssertGreaterThan(restoredGeneration, changedGeneration)
    XCTAssertEqual(try Data(contentsOf: raw), originalBytes)
  }

  private func sceneLinearPixels(_ image: CIImage) throws -> [Float] {
    let width = Int(image.extent.width)
    let height = Int(image.extent.height)
    XCTAssertGreaterThan(width * height, 0)
    var pixels = [Float](repeating: 0, count: width * height * 4)
    let context = CIContext(options: [.workingColorSpace: NSNull()])
    pixels.withUnsafeMutableBytes { bytes in
      context.render(
        image, toBitmap: bytes.baseAddress!, rowBytes: width * 16,
        bounds: image.extent, format: .RGBAf, colorSpace: nil)
    }
    return pixels
  }

}
