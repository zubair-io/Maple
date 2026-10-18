// DecodedCacheAgentCaptureTests.swift — #4715 review: agent canonical capture
// must read the decoded cache under the same live-model key the canvas wrote
// it with. A bytes-backed RAW (no sidecar URL, like Cloud or PhotoKit) with a
// decode-baked edit is the case where a disk-keyed snapshot stays stale.

import CoreImage
import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class DecodedCacheAgentCaptureTests: XCTestCase {
  private func remoteRawSession(model: AdjustmentModel) throws -> EditSession {
    let appleRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let fixture = appleRoot.appendingPathComponent(
      "MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
    let bytes = try Data(contentsOf: fixture)
    let asset = AssetRef(displayName: "agent-capture.dng", hintExtension: "dng") { bytes }
    XCTAssertNil(asset.sidecarURL, "precondition: remote-style asset with no sidecar on disk")
    let session = EditSession(asset: asset, model: model)
    session.nativeImageSize = CGSize(width: 64, height: 64)
    session.gpuLiveDriver = nil
    return session
  }

  func testAgentCaptureUsesTheLiveKeyForARemoteAssetWithABakedEdit() async throws {
    // A wide-gamut canvas, as on device: an sRGB preview would short-circuit
    // the capture before it ever reads the decoded cache.
    let defaults = UserDefaults.standard
    let saved = defaults.object(forKey: CanvasColorSpace.defaultsKey)
    defer {
      if let saved {
        defaults.set(saved, forKey: CanvasColorSpace.defaultsKey)
      } else {
        defaults.removeObject(forKey: CanvasColorSpace.defaultsKey)
      }
    }
    defaults.set(CanvasColorSpace.displayP3.rawValue, forKey: CanvasColorSpace.defaultsKey)
    var model = AdjustmentModel.default
    model.profile = .neutral
    model.highlightRecovery = .blend
    let session = try remoteRawSession(model: model)

    await session.decodeAndRender(targetSize: CGSize(width: 32, height: 32), phase: .fast)
    let canvasSnapshot = await session.renderActor.snapshot(
      forAsset: session.asset, liveModel: session.renderModel)
    XCTAssertTrue(canvasSnapshot.isFresh, "precondition: the canvas cached its decode live-keyed")

    let preview = try XCTUnwrap(session.renderedPreview)
    XCTAssertNotEqual(
      preview.colorSpace?.name, CGColorSpace.sRGB,
      "precondition: the capture must reach the decoded-cache read")
    let frame = try await session.agentCPUFrame(maskID: nil)
    XCTAssertGreaterThan(frame.canvas.extent.width, 0)
  }
}
