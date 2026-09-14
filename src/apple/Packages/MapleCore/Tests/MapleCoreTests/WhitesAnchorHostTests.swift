import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class WhitesAnchorHostTests: XCTestCase {
  func testDecodedAnchorInvalidatesCachedChainOutput() {
    let assetID = UUID()
    let cache = SceneLinearChainCache()
    cache._testSetEnabled(true)
    let key: (Float) -> SceneLinearChainCache.Key = { anchor in
      SceneLinearChainCache.make(
        assetID: assetID, model: .default,
        decodedTemperature: 6500, decodedTint: 0,
        skipAgX: false, width: 64, height: 64, whitesAnchorEv: anchor
      )
    }
    let image = CIImage(color: .white)
    cache.put(key(-2), image)
    XCTAssertNotNil(cache.get(key(-2)))
    XCTAssertNil(cache.get(key(1)))
    XCTAssertEqual(key(.nan), key(.nan))
  }

  func testSnapshotRetainsFullFrameAnchorUntilInvalidation() async {
    let actor = RenderActor(pipeline: ImageEditPipeline())
    let asset = AssetRef(
      displayName: "anchor.dng", hintExtension: "dng", stableID: "whites-anchor",
      explicitIsRaw: true, bytesProvider: { Data() }
    )
    let image = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 8))
    await actor._testSeedDecodedCache(
      asset: asset, decoded: image, rawResolution: CGSize(width: 8, height: 8),
      whitesAnchorEv: -2.5
    )
    let snapshot = await actor.snapshot(forAsset: asset)
    XCTAssertEqual(snapshot.whitesAnchorEv, -2.5)
    await actor.invalidate()
    let cleared = await actor.snapshot(forAsset: asset)
    XCTAssertTrue(cleared.whitesAnchorEv.isNaN)
  }

  func testCpuAndGpuParamsPreserveDecodedAnchor() {
    let anchor: Float = -1.375
    let cpu = PipelineRenderer.makeParams(from: .default, whitesAnchorEv: anchor)
    let gpu = PipelineRenderer.makeGpuLiveParams(from: .default, whitesAnchorEv: anchor)
    XCTAssertEqual(cpu.whites_anchor_ev.bitPattern, anchor.bitPattern)
    XCTAssertEqual(gpu.whites_anchor_ev.bitPattern, anchor.bitPattern)
  }
}
