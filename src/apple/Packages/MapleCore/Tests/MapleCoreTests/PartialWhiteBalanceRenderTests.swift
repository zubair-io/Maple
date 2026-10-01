import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class PartialWhiteBalanceRenderTests: XCTestCase {
  func testLiveGpuPixelsMatchExistingCorePartialResolutionOnNonzeroTintCamera() async throws {
    let fixture = try PartialWhiteBalanceFixture.root().appendingPathComponent("source.dng")
    let root = try SidecarContractIO.makeTempDirectory(prefix: "partial-wb-live")
    defer { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("source.dng")
    try FileManager.default.copyItem(at: fixture, to: raw)
    let originalBytes = try Data(contentsOf: raw)
    let decoded = try PipelineRenderer.renderSceneLinear(
      rawBytes: originalBytes, hint: "dng", quality: .full, profileOverride: .neutral)
    let frame = try XCTUnwrap(decoded.wbFrame)
    XCTAssertTrue(frame.isPresent)
    XCTAssertGreaterThan(abs(frame.asShotTint), 0.5)
    XCTAssertEqual(decoded.bytesPerPixel, 16)
    let pixels = decoded.pixels.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    let gpu = try GpuLiveSession(
      pixels: pixels, width: decoded.width, height: decoded.height,
      noiseProfile: decoded.noiseProfile, iso: decoded.iso, whitesAnchorEv: decoded.whitesAnchorEv)
    for version in 1...5 {
      for axis in [
        #"crs:Temperature="8500""#, #"crs:Tint="40""#,
        #"crs:Temperature="6500""#, #"crs:Tint="0""#,
      ] {
        let xml = """
          <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" crs:WhiteBalance="Custom" papp:Profile="Neutral" papp:WbScaleVersion="\(version)" \(axis)/></rdf:RDF></x:xmpmeta>
          """
        let sidecar = SidecarPath.sidecarURL(for: raw)
        try xml.write(to: sidecar, atomically: true, encoding: .utf8)
        let core = try PipelineRenderer.render(rawPath: raw, xmpPath: sidecar, quality: .full)
        let session = EditSession(asset: AssetRef(url: raw))
        await session.loadSidecar()
        XCTAssertNil(session.renderError)
        let maybeLive = try await gpu.renderToBuffer(
          model: session.model, asShotCCT: Double(frame.sceneCCT),
          asShotTint: Double(frame.asShotTint), wbFrame: frame)
        let live = try XCTUnwrap(maybeLive)
        XCTAssertEqual(core.width, decoded.width)
        XCTAssertEqual(core.height, decoded.height)
        XCTAssertEqual(live.count, core.pixels.count)
        // Import resolution must produce exactly the same live target as an
        // independently authored complete pair, without changing core math.
        var authored = session.model
        authored.partialWhiteBalance = nil
        let authoredLive = try await gpu.renderToBuffer(
          model: authored, asShotCCT: Double(frame.sceneCCT),
          asShotTint: Double(frame.asShotTint), wbFrame: frame)
        XCTAssertEqual(authoredLive, live)
        let metrics = try XCTUnwrap(
          CIEDE2000.compare(
            candidateRGBA: rgba(live), referenceRGBA: rgba(Array(core.pixels)),
            width: core.width, height: core.height))
        print(
          "partial WB V\(version) \(axis): GPU/core mean ΔE=\(metrics.meanDeltaE) p95=\(metrics.p95DeltaE) max=\(metrics.maxDeltaE)"
        )
        XCTAssertLessThanOrEqual(metrics.meanDeltaE, 1, "V\(version) \(axis)")
        XCTAssertLessThanOrEqual(metrics.p95DeltaE, 2, "V\(version) \(axis)")
        XCTAssertLessThanOrEqual(metrics.maxDeltaE, 2, "V\(version) \(axis)")
        if version == 5 && axis.contains("8500") {
          var wrong = session.model
          wrong.tint = 0
          let wrongLive = try await gpu.renderToBuffer(
            model: wrong, asShotCCT: Double(frame.sceneCCT), asShotTint: Double(frame.asShotTint),
            wbFrame: frame)
          XCTAssertNotEqual(
            wrongLive, live, "An invented zero tint must visibly change this fixture")
        }
      }
    }
    await gpu.close()
    XCTAssertEqual(try Data(contentsOf: raw), originalBytes)
  }

  private func rgba(_ rgb: [UInt8]) -> [UInt8] {
    stride(from: 0, to: rgb.count, by: 3).flatMap { (offset: Int) -> [UInt8] in
      [rgb[offset], rgb[offset + 1], rgb[offset + 2], 255]
    }
  }

}
