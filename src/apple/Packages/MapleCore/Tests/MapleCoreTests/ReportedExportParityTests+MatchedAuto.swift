import CoreImage
import Foundation
import RawPipeline
import XCTest

@testable import MapleCore

extension ReportedExportParityTests {
  /// #1472: isolate shader/scene differences from standalone fit size. The
  /// native artifacts are diagnostic controls, never installed in the editor.
  func testPhotographicMatchedAutoGpuDiagnostic() async throws {
    let corpus = AutoProfileCanvasParityTests.fixtureDir(
      "test-fixtures/raws/removal-photographic")
    let controls = corpus.appendingPathComponent("matched-auto")
    let manifestURL = controls.appendingPathComponent("manifest.json")
    guard FileManager.default.fileExists(atPath: manifestURL.path) else {
      throw XCTSkip("Generate matched photographic Auto controls (#1472)")
    }
    let source = corpus.appendingPathComponent("portrait.dng")
    let sourceHash = try SidecarContractIO.sha256(of: source)
    XCTAssertEqual(
      sourceHash, "4a4154b2595dc76a7d5e10cdcb65a386319e31647a585c23e262fe62b969c0fe")
    let manifest = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as? [String: Any])
    XCTAssertEqual(manifest["quality"] as? String, "amaze")
    XCTAssertEqual(
      manifest["sourceDigest"] as? String,
      String(try RemovalBridge.digest(Data(contentsOf: source)).dropFirst(7)))
    let entries = try XCTUnwrap(manifest["artifacts"] as? [[String: Any]])
    let (curve, _) = try matchedAutoArtifact("native-curve.f32", entries: entries, at: controls)
    let (residual, edge) = try matchedAutoArtifact(
      "native-residual.f32", entries: entries, at: controls)
    guard curve.count == Int(MAPLE_PROFILE_CURVE_FLAT_LEN), edge == 33,
      residual.count == 33 * 33 * 33 * 3
    else { throw RemovalError.invalid("Unexpected matched photographic Auto artifact extent") }
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "matched-auto-gpu")
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("portrait.dng")
    try FileManager.default.copyItem(at: source, to: raw)
    try FileManager.default.copyItem(
      at: corpus.appendingPathComponent(".maple"), to: directory.appendingPathComponent(".maple"))
    let originalXMP = try Data(contentsOf: corpus.appendingPathComponent("portrait.xmp"))
    let saved = try XMPParser.parse(data: originalXMP).0
    XCTAssertNotNil(saved.inpaintRemovals)
    for accepted in [false, true] {
      var model = saved
      model.profile = .auto
      if !accepted { model.inpaintRemovals = nil }
      // This source's accepted stack has no other array stages. Fail rather
      // than accidentally omit a newly introduced stage from this control.
      XCTAssertTrue(model.toneCurveLuma.points.isEmpty)
      XCTAssertTrue(model.toneCurveRed.points.isEmpty)
      XCTAssertTrue(model.toneCurveGreen.points.isEmpty)
      XCTAssertTrue(model.toneCurveBlue.points.isEmpty)
      XCTAssertTrue(model.localAdjustments.isEmpty)
      XCTAssertTrue(model.filmLook.isEmpty)
      let xmp = SidecarPath.sidecarURL(for: raw)
      try XMPSerializer.serialize(model: model, culling: CullingState()).write(
        to: xmp, atomically: true, encoding: .utf8)
      let reference = try PipelineRenderer.render(rawPath: raw, xmpPath: xmp, quality: .amaze)
      let pipeline = ImageEditPipeline()
      let result = await pipeline.decodeSceneLinear(
        asset: AssetRef(url: raw), quality: .amaze, xmpPath: xmp,
        profileOverride: .auto, autoExposureOverride: model.autoExposure)
      let decoded = try XCTUnwrap(result)
      let floats = try XCTUnwrap(pipeline.sceneLinearFloats(from: decoded.image, targetSize: nil))
      XCTAssertEqual([floats.width, floats.height], [reference.width, reference.height])
      let anchor = decoded.wbFrame.flatMap { frame -> ImageEditPipeline.AsShotWB? in
        guard frame.isPresent else { return nil }
        return .init(temperature: Double(frame.sceneCCT), tint: Double(frame.asShotTint))
      }
      var params = PipelineRenderer.makeGpuLiveParams(
        from: model, asShotCCT: anchor?.temperature, asShotTint: anchor?.tint,
        wbFrame: decoded.wbFrame, whitesAnchorEv: decoded.whitesAnchorEv,
        targetColorSpace: .srgb)
      params.iso = decoded.iso
      let output = try matchedGpuReadback(
        pixels: floats.pixels, width: floats.width, height: floats.height,
        params: params, noise: decoded.noiseProfile ?? [],
        curve: curve, residual: residual, edge: edge)
      XCTAssertEqual(output.count, reference.pixels.count)
      let stats = zip(output, reference.pixels).reduce((maximum: 0, over1: 0, sum: 0)) { s, pair in
        let error = abs(Int(pair.0) - Int(pair.1))
        return (max(s.maximum, error), s.over1 + (error > 1 ? 1 : 0), s.sum + error)
      }
      XCTAssertLessThanOrEqual(stats.maximum, 1, "Matched Auto Metal must reproduce shared RAW")
      XCTAssertEqual(stats.over1, 0)
      let report: [String: Any] = [
        "case": "photographic-removal-matched-native-auto-metal", "accepted": accepted,
        "width": floats.width, "height": floats.height,
        "maximumChannelError": stats.maximum, "channelsOver1": stats.over1,
        "meanChannelError": Double(stats.sum) / Double(output.count),
        "outputDigest": try RemovalBridge.digest(Data(output)),
        "limit": "Matched native-fit parity <=1/255; not live performance or production fit policy",
      ]
      let bytes = try JSONSerialization.data(withJSONObject: report, options: .sortedKeys)
      print("MAPLE_REMOVAL_MATCHED_AUTO \(String(decoding: bytes, as: UTF8.self))")
    }
    XCTAssertEqual(try SidecarContractIO.sha256(of: source), sourceHash)
    XCTAssertEqual(try SidecarContractIO.sha256(of: raw), sourceHash)
    XCTAssertEqual(try Data(contentsOf: corpus.appendingPathComponent("portrait.xmp")), originalXMP)
  }

  private func matchedAutoArtifact(
    _ name: String, entries: [[String: Any]], at directory: URL
  ) throws -> ([Float], Int) {
    let entry = try XCTUnwrap(entries.first { $0["path"] as? String == name })
    let bytes = try Data(contentsOf: directory.appendingPathComponent(name))
    let digest = try XCTUnwrap(entry["blake3"] as? String)
    guard bytes.count == entry["bytes"] as? Int, bytes.count % 4 == 0,
      try RemovalBridge.digest(bytes) == "blake3:\(digest)"
    else { throw RemovalError.invalid("Matched Auto control failed verification") }
    let lanes = bytes.withUnsafeBytes { buffer in
      (0..<(bytes.count / 4)).map { buffer.loadUnaligned(fromByteOffset: $0 * 4, as: Float.self) }
    }
    XCTAssertTrue(lanes.allSatisfy(\.isFinite))
    return (lanes, try XCTUnwrap(entry["edge"] as? Int))
  }

  /// Synchronous test-only FFI owner: open/render/close stay on this actor.
  /// The normal editor's GpuLiveSession API and artifacts are unchanged.
  private func matchedGpuReadback(
    pixels: [Float], width: Int, height: Int, params: MapleGpuLiveParams,
    noise: [Float], curve: [Float], residual: [Float], edge: Int
  ) throws -> [UInt8] {
    var handle = MapleGpuLiveSession()
    let openRC = pixels.withUnsafeBufferPointer {
      maple_gpu_live_open($0.baseAddress, UInt32(width), UInt32(height), &handle)
    }
    guard openRC == 0 else { throw RemovalError.invalid("Matched GPU open failed: \(openRC)") }
    defer { maple_gpu_live_close(&handle) }
    var output = [UInt8](repeating: 0, count: width * height * 3)
    let rc = noise.withUnsafeBufferPointer { np in
      curve.withUnsafeBufferPointer { cp in
        residual.withUnsafeBufferPointer { lp in
          var p = params
          p.noise_profile_ptr = np.baseAddress
          p.noise_profile_len = UInt32(np.count)
          p.profile_curve_ptr = cp.baseAddress
          p.profile_curve_len = UInt(cp.count)
          p.residual_lut_ptr = lp.baseAddress
          p.residual_lut_len = UInt(lp.count)
          p.residual_lut_size = UInt32(edge)
          return output.withUnsafeMutableBufferPointer {
            maple_gpu_live_render(&handle, &p, $0.baseAddress)
          }
        }
      }
    }
    guard rc == 0 else { throw RemovalError.invalid("Matched GPU render failed: \(rc)") }
    return output
  }
}
