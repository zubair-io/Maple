import CoreGraphics
import XCTest

@testable import MapleCore

@MainActor
final class MaskGroupRasterLifecycleTests: EditorTestCase {
  private let digests = ["a123456789abcdef", "b123456789abcdef"]
  private func staged() async throws -> URL {
    let source = try XCTUnwrap(
      Bundle.module.url(forResource: "portrait-skin-test", withExtension: "png"))
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "mask-group-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let asset = directory.appendingPathComponent("portrait.png")
    try FileManager.default.copyItem(at: source, to: asset)
    let store = MaskRasterStore(directory: directory.appendingPathComponent(".maple/masks"))
    for (index, digest) in digests.enumerated() {
      let bytes = (0..<64 * 48).map { UInt8(($0 % 64 < 32) == (index == 0) ? 255 : 0) }
      _ = try await store.raster(for: digest, model: "apple-vision-person-instance/1") {
        (64, 48, bytes)
      }
    }
    let components = try digests.enumerated().map { index, digest in
      try XCTUnwrap(
        MaskComponent(
          mask: .bitmap(
            recipe: BitmapRecipe(
              person: index, facialSkin: true, bodySkin: true,
              model: "apple-vision-person-instance/1", digest: digest), rasterId: 0),
          combine: index == 0 ? .add : .subtract))
    }
    var model = AdjustmentModel.default
    model.localAdjustments = [
      LocalAdjustment(
        mask: .group(MaskGroup(components: components, opacity: 0.75)),
        adjustments: PartialAdjustments(exposure: 1))
    ]
    let sidecar = XMPSidecarStore(rawURL: asset)
    await sidecar.update(model: model, culling: CullingState())
    await sidecar.flush()
    return asset
  }

  func testReopenRegistersEveryComponentAndCropCachesEachDerivedRaster() async throws {
    let asset = try await staged()
    defer { try? FileManager.default.removeItem(at: asset.deletingLastPathComponent()) }
    let session = EditSession(asset: AssetRef(url: asset))
    await session.loadSidecar()
    let layer = try XCTUnwrap(session.model.localAdjustments.first)
    let ids = layer.mask.bitmapMasks.map(\.rasterId)
    XCTAssertEqual(ids.count, 2)
    XCTAssertEqual(Set(ids).count, 2)
    XCTAssertFalse(ids.contains(0))
    XCTAssertEqual(session.model, session.originalModel)
    let scope = try await EditSession.renderScopeSample(
      asset: session.asset, model: session.model, layerIndex: 0)
    XCTAssertGreaterThan(scope.total, 0)
    let affine = MaskAffine.cropToFullFrame(
      Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.8, angle: 7),
      nativeSize: CGSize(width: 640, height: 480))
    let first = await session.remappedLocalAdjustments([layer], through: affine)
    let derived = first[0].mask.bitmapMasks.map(\.rasterId)
    XCTAssertEqual(Set(derived).count, 2)
    XCTAssertFalse(derived.contains(0))
    XCTAssertTrue(Set(derived).isDisjoint(with: Set(ids)))
    let again = await session.remappedLocalAdjustments([layer], through: affine)
    XCTAssertEqual(again[0].mask, first[0].mask)
    XCTAssertEqual(first[0].adjustments, layer.adjustments)
  }

  func testMissingSourceDuringCropMakesInvertedGroupInert() async throws {
    let id = try XCTUnwrap(
      MaskRasterRegistry.register(digest: "f123456789abcdef", width: 2, height: 1, bytes: [255, 0]))
    defer { MaskRasterRegistry.release(id) }
    let recipe = BitmapRecipe(
      person: 0, facialSkin: true, bodySkin: true, model: "vision", digest: "f123456789abcdef")
    let mask = LocalMask.group(
      MaskGroup(
        components: [
          try XCTUnwrap(MaskComponent(mask: .everywhere)),
          try XCTUnwrap(
            MaskComponent(mask: .bitmap(recipe: recipe, rasterId: id), combine: .subtract)),
        ], invert: true))
    let session = EditSession.preview()
    let layers = await session.remappedLocalAdjustments(
      [
        LocalAdjustment(mask: mask, adjustments: PartialAdjustments(exposure: 1))
      ], through: MaskAffine(a: 0.5, b: 0, c: 0, d: 1, tx: 0.1, ty: 0))
    XCTAssertEqual(layers[0].mask.bitmapMasks.map(\.rasterId), [0])
    XCTAssertEqual(MaskWeight.evaluate(layers[0].mask, x: 0.5, y: 0.5), 0)
  }
}
