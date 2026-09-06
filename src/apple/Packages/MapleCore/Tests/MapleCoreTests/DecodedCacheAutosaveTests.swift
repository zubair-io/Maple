import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class DecodedCacheAutosaveTests: XCTestCase {
  func testAutosaveAcceptsNewMtimeAndFollowingTicksSkipXMPParse() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let original = directory.appendingPathComponent("autosave.dng")
    try Data([0x44, 0x4E, 0x47]).write(to: original)
    let asset = AssetRef(url: original)
    let sidecar = try XCTUnwrap(asset.sidecarURL)
    let initialMtime = Date(timeIntervalSince1970: 1_700_000_000)
    let savedMtime = initialMtime.addingTimeInterval(1)
    let changedMtime = savedMtime.addingTimeInterval(1)
    var model = AdjustmentModel()
    model.highlightRecovery = .blend
    try write(model, to: sidecar, mtime: initialMtime)
    let renderer = RenderActor(pipeline: ImageEditPipeline())
    await renderer._testSeedDecodedCache(
      asset: asset,
      decoded: CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 10, height: 10)),
      rawResolution: CGSize(width: 10, height: 10)
    )

    // A real autosave changes only a live-applied field. One parse validates
    // the baked fields and advances the timestamp gate for subsequent ticks.
    model.exposure = 0.75
    try write(model, to: sidecar, mtime: savedMtime)
    let afterSave = await renderer.snapshot(forAsset: asset)
    XCTAssertTrue(afterSave.isFresh)
    let acceptedMtime = await renderer.decodedSidecarMtime
    XCTAssertEqual(acceptedMtime, savedMtime)

    // Deliberately preserve the accepted timestamp while writing a distinct
    // real XMP model. A parse would now report stale; fresh snapshots prove
    // the unchanged-mtime fast path does not parse on subsequent ticks.
    model.highlightRecovery = .luminance
    try write(model, to: sidecar, mtime: savedMtime)
    let diskBakedModel = RenderActor.bakedModel(for: asset)
    let cachedBakedModel = await renderer.decodedBakedModel
    XCTAssertNotEqual(diskBakedModel, cachedBakedModel)
    for _ in 0..<5 {
      let snapshot = await renderer.snapshot(forAsset: asset)
      XCTAssertTrue(snapshot.isFresh)
    }

    // Once a baked-field change has a new mtime, it must invalidate rather
    // than being accepted as another live-only autosave.
    try FileManager.default.setAttributes(
      [.modificationDate: changedMtime], ofItemAtPath: sidecar.path)
    let afterBakedChange = await renderer.snapshot(forAsset: asset)
    XCTAssertFalse(afterBakedChange.isFresh)
    let rejectedMtime = await renderer.decodedSidecarMtime
    XCTAssertEqual(rejectedMtime, savedMtime)
  }

  private func write(_ model: AdjustmentModel, to url: URL, mtime: Date) throws {
    try XMPSerializer.serialize(model: model, culling: CullingState())
      .write(to: url, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.modificationDate: mtime], ofItemAtPath: url.path)
  }
}
