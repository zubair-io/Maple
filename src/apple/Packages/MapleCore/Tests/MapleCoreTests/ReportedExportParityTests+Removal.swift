import CoreImage
import Foundation
import RawPipeline
import XCTest

@testable import MapleCore

extension ReportedExportParityTests {
  /// Photographic attribution for #1472, separate from the tiny fixture gate.
  /// Full export arms gate at 1/255. Other controls remain attribution only.
  func testPhotographicSavedRemovalExportDiagnostic() async throws {
    let corpus = AutoProfileCanvasParityTests.fixtureDir(
      "test-fixtures/raws/removal-photographic")
    let source = corpus.appendingPathComponent("portrait.dng")
    let autoFit = corpus.appendingPathComponent("auto-fit")
    guard FileManager.default.fileExists(atPath: source.path),
      FileManager.default.fileExists(atPath: autoFit.appendingPathComponent("manifest.json").path)
    else {
      throw XCTSkip("Install the photographic accepted-removal corpus (#1472)")
    }
    let sourceHash = try SidecarContractIO.sha256(of: source)
    XCTAssertEqual(
      sourceHash, "4a4154b2595dc76a7d5e10cdcb65a386319e31647a585c23e262fe62b969c0fe")
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "removal-export-parity")
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("portrait.dng")
    try FileManager.default.copyItem(at: source, to: raw)
    try FileManager.default.copyItem(
      at: corpus.appendingPathComponent(".maple"), to: directory.appendingPathComponent(".maple"))
    let originalXMP = try Data(contentsOf: corpus.appendingPathComponent("portrait.xmp"))
    let saved = try XMPParser.parse(data: originalXMP).0
    XCTAssertNotNil(saved.inpaintRemovals)
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let results = FileManager.default.temporaryDirectory.appendingPathComponent(
      "maple-1472-photographic-export-parity")
    try FileManager.default.createDirectory(at: results, withIntermediateDirectories: true)
    for (accepted, profile) in [
      (false, Profile.neutral), (true, Profile.neutral),
      (false, Profile.auto), (true, Profile.auto),
    ] {
      var model = saved
      model.profile = profile
      if !accepted { model.inpaintRemovals = nil }
      let xml = XMPSerializer.serialize(model: model, culling: CullingState())
      try xml.write(to: sidecar, atomically: true, encoding: .utf8)
      let reference = try PipelineRenderer.render(rawPath: raw, xmpPath: sidecar, quality: .amaze)
      let actual = try await RenderActor(pipeline: ImageEditPipeline()).renderForExport(
        asset: AssetRef(url: raw), model: model, asShot: nil, qualityOverride: .amaze,
        targetPrimariesOverride: .srgb)
      XCTAssertEqual(Int(actual.extent.width), reference.width)
      XCTAssertEqual(Int(actual.extent.height), reference.height)
      let png = try await MapleExporter.encodeOffMainActor(actual, options: .init(format: .png))
      let stem = "\(profile)-\(accepted ? "saved" : "original")"
      try png.write(to: results.appendingPathComponent("\(stem).png"))
      let delivered = try XCTUnwrap(CIImage(data: png))
      for (stage, image) in [("developed", actual), ("delivered", delivered)] {
        let stats = removalExportDifference(image, reference: reference)
        XCTAssertLessThanOrEqual(stats.max, 1, "Native full export must match shared Auto/Neutral")
        let report: [String: Any] = [
          "case": "photographic-removal-export", "stage": stage,
          "profile": String(describing: profile), "accepted": accepted,
          "width": reference.width, "height": reference.height,
          "maximumChannelError": stats.max, "meanChannelError": stats.mean,
          "channelsOver1": stats.over1, "artifact": results.path,
          "limit": "Native full export parity gate: maximum channel error <=1/255",
        ]
        let data = try JSONSerialization.data(withJSONObject: report, options: .sortedKeys)
        print("MAPLE_REMOVAL_EXPORT_DIAGNOSTIC \(String(decoding: data, as: UTF8.self))")
      }
      if accepted && profile == .auto {
        try await diagnoseRemovalAutoCube(
          raw: raw, model: model, reference: reference, autoFit: autoFit)
      }
    }
    XCTAssertEqual(try SidecarContractIO.sha256(of: raw), sourceHash)
    XCTAssertEqual(try SidecarContractIO.sha256(of: source), sourceHash)
    XCTAssertEqual(try Data(contentsOf: corpus.appendingPathComponent("portrait.xmp")), originalXMP)
  }

  private func diagnoseRemovalAutoCube(
    raw: URL, model: AdjustmentModel, reference: MapleImageData, autoFit: URL
  )
    async throws
  {
    let pipeline = ImageEditPipeline()
    let decodeResult = await pipeline.decodeSceneLinear(
      asset: AssetRef(url: raw), quality: .amaze, xmpPath: SidecarPath.sidecarURL(for: raw),
      profileOverride: .auto, autoExposureOverride: model.autoExposure)
    let decoded = try XCTUnwrap(decodeResult)
    let anchor = decoded.wbFrame.flatMap { frame -> ImageEditPipeline.AsShotWB? in
      guard frame.isPresent else { return nil }
      return .init(temperature: Double(frame.sceneCCT), tint: Double(frame.asShotTint))
    }
    let encoded = pipeline.processSceneLinear(
      decoded: decoded.image, model: model, asShot: anchor,
      noiseProfile: decoded.noiseProfile, iso: decoded.iso,
      wbFrame: decoded.wbFrame, whitesAnchorEv: decoded.whitesAnchorEv,
      targetPrimariesOverride: .srgb)
    for dimension in [33, 49, 65] {
      var lut = [Float](repeating: 0, count: dimension * dimension * dimension * 3)
      let rc = raw.path.withCString { path in
        lut.withUnsafeMutableBufferPointer {
          maple_compute_auto_profile_lut(
            path, nil, PipelineRenderer.Quality.amaze.rawValue, UInt32(dimension), $0.baseAddress)
        }
      }
      XCTAssertEqual(rc, 0)
      guard rc == 0 else { throw RemovalError.invalid("Auto cube diagnostic failed: \(rc)") }
      let expectedProxy = try Data(
        contentsOf: autoFit.appendingPathComponent("proxy-\(dimension).f32"))
      XCTAssertEqual(
        lut.withUnsafeBytes { Data($0) }, expectedProxy,
        "The AMaZE FFI fit must match the independently generated AMaZE proxy control")
      let cube = try XCTUnwrap(AutoProfileLUT.buildCubeFromLUT(lut, dimension: dimension))
      let filter = try XCTUnwrap(AutoProfileLUT.makeFilter(from: cube))
      let stats = removalExportDifference(
        AutoProfileLUT.apply(filter, to: encoded), reference: reference)
      let report: [String: Any] = [
        "case": "photographic-removal-auto-cube", "dimension": dimension,
        "fitOrigin": "standalone-proxy",
        "maximumChannelError": stats.max, "meanChannelError": stats.mean,
        "channelsOver1": stats.over1,
        "limit": "Attribution diagnostic; production cube unchanged",
      ]
      let data = try JSONSerialization.data(withJSONObject: report, options: .sortedKeys)
      print("MAPLE_REMOVAL_EXPORT_DIAGNOSTIC \(String(decoding: data, as: UTF8.self))")
    }
    let manifest = try XCTUnwrap(
      JSONSerialization.jsonObject(
        with: Data(contentsOf: autoFit.appendingPathComponent("manifest.json"))) as? [String: Any])
    let digest = String(try RemovalBridge.digest(Data(contentsOf: raw)).dropFirst(7))
    XCTAssertEqual(manifest["sourceDigest"] as? String, digest)
    let cubes = try XCTUnwrap(manifest["cubes"] as? [[String: Any]])
    for dimension in [33, 49, 65] {
      let name = "native-\(dimension).f32"
      let bytes = try Data(contentsOf: autoFit.appendingPathComponent(name))
      let entry = try XCTUnwrap(cubes.first { $0["path"] as? String == name })
      let expectedDigest = try XCTUnwrap(entry["blake3"] as? String)
      guard bytes.count == dimension * dimension * dimension * 3 * MemoryLayout<Float>.size,
        try RemovalBridge.digest(bytes) == "blake3:\(expectedDigest)"
      else { throw RemovalError.invalid("Native Auto cube control failed verification") }
      let lut = bytes.withUnsafeBytes { buffer in
        (0..<(bytes.count / 4)).map { buffer.loadUnaligned(fromByteOffset: $0 * 4, as: Float.self) }
      }
      let cube = try XCTUnwrap(AutoProfileLUT.buildCubeFromLUT(lut, dimension: dimension))
      let filter = try XCTUnwrap(AutoProfileLUT.makeFilter(from: cube))
      let stats = removalExportDifference(
        AutoProfileLUT.apply(filter, to: encoded), reference: reference)
      let report: [String: Any] = [
        "case": "photographic-removal-auto-cube", "dimension": dimension,
        "fitOrigin": "native-control",
        "maximumChannelError": stats.max, "meanChannelError": stats.mean,
        "channelsOver1": stats.over1,
        "limit": "Uncached diagnostic native fit; production policy unchanged",
      ]
      let data = try JSONSerialization.data(withJSONObject: report, options: .sortedKeys)
      print("MAPLE_REMOVAL_EXPORT_DIAGNOSTIC \(String(decoding: data, as: UTF8.self))")
    }
    let previousSpace = UserDefaults.standard.object(forKey: CanvasColorSpace.defaultsKey)
    UserDefaults.standard.set(CanvasColorSpace.srgb.rawValue, forKey: CanvasColorSpace.defaultsKey)
    defer {
      if let previousSpace {
        UserDefaults.standard.set(previousSpace, forKey: CanvasColorSpace.defaultsKey)
      } else {
        UserDefaults.standard.removeObject(forKey: CanvasColorSpace.defaultsKey)
      }
    }
    let floats = try XCTUnwrap(pipeline.sceneLinearFloats(from: decoded.image, targetSize: nil))
    let gpu = try GpuLiveSession(
      pixels: floats.pixels, width: floats.width, height: floats.height,
      noiseProfile: decoded.noiseProfile, iso: decoded.iso, whitesAnchorEv: decoded.whitesAnchorEv)
    do {
      await gpu.fitAutoProfile(rawPath: raw.path, quality: .amaze)
      let frame = try await gpu.renderToBuffer(
        model: model, asShotCCT: anchor?.temperature, asShotTint: anchor?.tint,
        wbFrame: decoded.wbFrame)
      let bytes = try XCTUnwrap(frame)
      guard bytes.count == reference.pixels.count else {
        throw RemovalError.invalid("Metal photographic readback has incorrect dimensions")
      }
      let stats = removalChannelDifference(Data(bytes), channels: 3, reference: reference)
      let report: [String: Any] = [
        "case": "photographic-removal-full-metal", "width": floats.width, "height": floats.height,
        "maximumChannelError": stats.max, "meanChannelError": stats.mean,
        "channelsOver1": stats.over1,
        "limit": "Attribution diagnostic; full-resolution readback is not a live-slider benchmark",
      ]
      let data = try JSONSerialization.data(withJSONObject: report, options: .sortedKeys)
      print("MAPLE_REMOVAL_EXPORT_DIAGNOSTIC \(String(decoding: data, as: UTF8.self))")
      await gpu.close()
    } catch {
      await gpu.close()
      throw error
    }
  }

  private func removalExportDifference(_ image: CIImage, reference: MapleImageData)
    -> (max: Int, mean: Double, over1: Int)
  {
    let width = reference.width
    let height = reference.height
    var actual = Data(count: width * height * 4)
    actual.withUnsafeMutableBytes {
      CIContext(options: [.workingFormat: CIFormat.RGBAf, .cacheIntermediates: false]).render(
        image, toBitmap: $0.baseAddress!, rowBytes: width * 4, bounds: image.extent,
        format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    }
    return removalChannelDifference(actual, channels: 4, reference: reference)
  }

  private func removalChannelDifference(_ actual: Data, channels: Int, reference: MapleImageData)
    -> (max: Int, mean: Double, over1: Int)
  {
    return actual.withUnsafeBytes { bytes in
      reference.pixels.withUnsafeBytes { expected in
        let a = bytes.bindMemory(to: UInt8.self)
        let b = expected.bindMemory(to: UInt8.self)
        var maximum = 0
        var sum = 0
        var over1 = 0
        for index in 0..<b.count {
          let error = abs(Int(a[index / 3 * channels + index % 3]) - Int(b[index]))
          maximum = max(maximum, error)
          sum += error
          if error > 1 { over1 += 1 }
        }
        return (maximum, Double(sum) / Double(b.count), over1)
      }
    }
  }
}
