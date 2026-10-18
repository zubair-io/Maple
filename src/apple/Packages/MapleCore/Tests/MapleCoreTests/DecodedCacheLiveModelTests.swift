// DecodedCacheLiveModelTests.swift — #4715: decoded-cache freshness keys on
// the LIVE baked model the session hands in, not on the debounced on-disk
// sidecar. A heal spot, a highlight-recovery toggle, lens correction or
// deep denoise must flip `isFresh` on the very tick they are edited, with
// nothing written to disk — and for remote assets (no sidecar URL at all)
// this is the only way a baked edit can ever reach the canvas.

import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class DecodedCacheLiveModelTests: XCTestCase {

  private func makeLocalAsset() throws -> (asset: AssetRef, dir: URL) {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("live-model.dng")
    try Data([0x44, 0x4E, 0x47]).write(to: url)
    return (AssetRef(url: url), dir)
  }

  private func makeRemoteAsset() -> AssetRef {
    AssetRef(
      displayName: "remote.dng", hintExtension: "dng", stableID: "remote-4715",
      bytesProvider: { throw NSError(domain: "test", code: -1) })
  }

  private func seededActor(_ asset: AssetRef) async -> RenderActor {
    let actor = RenderActor(pipeline: ImageEditPipeline())
    await actor._testSeedDecodedCache(
      asset: asset,
      decoded: CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 10, height: 10)),
      rawResolution: CGSize(width: 10, height: 10))
    return actor
  }

  private var healSpot: RetouchSpot {
    RetouchSpot(
      kind: .heal, center: RetouchPoint(x: 0.4, y: 0.5), source: RetouchPoint(x: 0.6, y: 0.5))
  }

  func testRetouchSpotEditFlipsFreshnessWithoutAnyDiskWrite() async throws {
    let (asset, dir) = try makeLocalAsset()
    defer { try? FileManager.default.removeItem(at: dir) }
    let actor = await seededActor(asset)
    let sidecar = try XCTUnwrap(asset.sidecarURL)

    let untouched = await actor.snapshot(forAsset: asset, liveModel: AdjustmentModel())
    XCTAssertTrue(untouched.isFresh)

    var edited = AdjustmentModel()
    edited.retouchSpots = [healSpot]
    let afterSpot = await actor.snapshot(forAsset: asset, liveModel: edited)
    XCTAssertFalse(afterSpot.isFresh, "a heal spot bakes into the decode and must invalidate")
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: sidecar.path),
      "freshness must come from the live model, never from a sidecar write")
  }

  func testEveryDecodeBakedEditFlipsFreshnessOnTheLiveModel() async throws {
    let (asset, dir) = try makeLocalAsset()
    defer { try? FileManager.default.removeItem(at: dir) }
    let actor = await seededActor(asset)

    var highlights = AdjustmentModel()
    highlights.highlightRecovery = .blend
    var lens = AdjustmentModel()
    lens.lensProfileEnable = .off
    var denoise = AdjustmentModel()
    denoise.deepDenoise = 40
    let cases = [
      ("highlightRecovery", highlights), ("lens", lens), ("deepDenoise", denoise),
    ]
    for (name, model) in cases {
      let snapshot = await actor.snapshot(forAsset: asset, liveModel: model)
      XCTAssertFalse(snapshot.isFresh, "\(name) is decode-baked and must invalidate")
    }
  }

  func testStrippedEditsAndLiveOverridesKeepTheCacheFresh() async throws {
    let (asset, dir) = try makeLocalAsset()
    defer { try? FileManager.default.removeItem(at: dir) }
    let actor = await seededActor(asset)

    var live = AdjustmentModel()
    live.exposure = 1.2
    live.nrColor = 80
    live.sharpenAmount = 90
    live.profile = .neutral
    live.autoExposure = .off
    let snapshot = await actor.snapshot(forAsset: asset, liveModel: live)
    XCTAssertTrue(
      snapshot.isFresh, "live-chain fields and the override-owned profile/AE never invalidate")
  }

  func testRemoteAssetBakedEditFlipsFreshness() async throws {
    let asset = makeRemoteAsset()
    XCTAssertNil(asset.sidecarURL, "precondition: no on-disk sidecar for a remote asset")
    let actor = await seededActor(asset)

    let fresh = await actor.snapshot(forAsset: asset, liveModel: AdjustmentModel())
    XCTAssertTrue(fresh.isFresh)
    var edited = AdjustmentModel()
    edited.retouchSpots = [healSpot]
    let stale = await actor.snapshot(forAsset: asset, liveModel: edited)
    XCTAssertFalse(stale.isFresh, "remote edits have no sidecar to read; the live model is the key")
  }

  func testLiveModelFreshnessIgnoresAStaleOnDiskSidecar() async throws {
    let (asset, dir) = try makeLocalAsset()
    defer { try? FileManager.default.removeItem(at: dir) }
    let actor = await seededActor(asset)
    let sidecar = try XCTUnwrap(asset.sidecarURL)
    var onDisk = AdjustmentModel()
    onDisk.retouchSpots = [healSpot]
    try XMPSerializer.serialize(model: onDisk, culling: CullingState())
      .write(to: sidecar, atomically: true, encoding: .utf8)

    let diskSays = await actor.snapshot(forAsset: asset)
    XCTAssertFalse(diskSays.isFresh, "the sidecar-keyed path still reads the disk")
    let liveSays = await actor.snapshot(forAsset: asset, liveModel: AdjustmentModel())
    XCTAssertTrue(liveSays.isFresh, "with a live model the debounced sidecar is not consulted")
  }

  func testCropAndPerspectiveEditsKeepTheCacheFresh() async throws {
    let (asset, dir) = try makeLocalAsset()
    defer { try? FileManager.default.removeItem(at: dir) }
    let actor = await seededActor(asset)
    var presentation = AdjustmentModel()
    presentation.crop = Crop(top: 0.25, left: 0.25, bottom: 0.75, right: 0.75)
    presentation.perspective.rotate = 12
    let snapshot = await actor.snapshot(forAsset: asset, liveModel: presentation)
    XCTAssertTrue(
      snapshot.isFresh, "crop and perspective are applied on the developed image, not baked")
  }

  /// The live key runs on every slider tick in place of the mtime stat +
  /// occasional XMP parse. A thousand checks must fit inside one 16 ms
  /// frame, so a single one costs well under the budget's noise floor.
  func testLiveModelFreshnessCheckStaysFarInsideTheTickBudget() async throws {
    let (asset, dir) = try makeLocalAsset()
    defer { try? FileManager.default.removeItem(at: dir) }
    let actor = await seededActor(asset)
    var live = AdjustmentModel()
    live.exposure = 0.3
    live.localAdjustments = []
    _ = await actor.snapshot(forAsset: asset, liveModel: live)
    let started = DispatchTime.now().uptimeNanoseconds
    for _ in 0..<1000 {
      _ = await actor.snapshot(forAsset: asset, liveModel: live)
    }
    let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
    XCTAssertLessThan(elapsedMs, 16, "1000 live freshness checks took \(elapsedMs) ms")
  }

  func testLiveBakedModelNormalisesProfileAndAutoExposure() {
    var model = AdjustmentModel()
    model.profile = .neutral
    model.autoExposure = .off
    model.exposure = 2
    let baked = RenderActor.bakedModel(fromLive: model)
    XCTAssertEqual(baked.profile, AdjustmentModel().profile)
    XCTAssertEqual(baked.autoExposure, AdjustmentModel().autoExposure)
    XCTAssertEqual(baked.exposure, 0, "stripped fields are zeroed in the baked key")
    XCTAssertEqual(baked, RenderActor.bakedModel(fromLive: AdjustmentModel()))
  }

  func testFailedLiveXMPWriteFailsTheDecodeInsteadOfUsingTheDiskSidecar() {
    let disk = URL(fileURLWithPath: "/tmp/photo.xmp")
    let live = URL(fileURLWithPath: "/tmp/maple-strip-live.xmp")
    XCTAssertEqual(
      RenderActor.decodeXMPSource(hasLiveModel: true, liveXMP: nil, diskSidecar: disk), .fail)
    XCTAssertEqual(
      RenderActor.decodeXMPSource(hasLiveModel: true, liveXMP: live, diskSidecar: disk),
      .use(live))
    XCTAssertEqual(
      RenderActor.decodeXMPSource(hasLiveModel: false, liveXMP: nil, diskSidecar: disk),
      .use(disk))
    XCTAssertEqual(
      RenderActor.decodeXMPSource(hasLiveModel: false, liveXMP: nil, diskSidecar: nil), .use(nil))
  }

  func testExportReusesTheInteractiveDecodeForCropAndPerspectiveEdits() {
    let cached = RenderActor.bakedModel(fromLive: AdjustmentModel())
    var geometry = AdjustmentModel()
    geometry.crop = Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9)
    geometry.perspective.vertical = 8
    XCTAssertTrue(RenderActor.exportCanReuse(cachedBakedModel: cached, live: geometry))

    var baked = AdjustmentModel()
    baked.retouchSpots = [healSpot]
    XCTAssertFalse(RenderActor.exportCanReuse(cachedBakedModel: cached, live: baked))
    XCTAssertTrue(RenderActor.exportCanReuse(cachedBakedModel: nil, live: AdjustmentModel()))
  }
}
