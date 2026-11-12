// NativeDetailGpuCanvasHazeTests.swift — #5215.
//
// The 100% patch recovers dehaze with a haze map the host hands it. While
// the GPU-live canvas is on glass that map must be the one the canvas
// itself recovers with, i.e. measured from the prescaled buffer the GPU
// session was uploaded with, not from the full-resolution decoded base:
// tone curves, clarity and texture do not commute with the prescale.
//
// The reference is the GPU canvas: a real `GpuLiveDriver` session opened on
// exactly the upload `presentViaGpuLive` reads back, rendered headless
// (`renderToBuffer`, the present's own chain + dither). The candidate is
// the production windowed chain (`processSceneLinearWindow`) recovering
// with the map `canvasHazeSource` selects; the old behaviour (the decoded
// base's map) is rendered beside it.

import CoreImage
import XCTest

@testable import MapleCore

@MainActor
final class NativeDetailGpuCanvasHazeTests: XCTestCase {
  private typealias Frame = (pixels: [Float], width: Int, height: Int)

  /// What the windowed chain needs from the decode besides its pixels.
  private struct DecodeExports {
    var iso: UInt32 = 0
    var wbFrame: WbSliderFrame?
    var whitesAnchorEv: Float = .nan
  }

  private let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
  private let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

  private func image(_ frame: Frame) -> CIImage {
    CIImage(
      bitmapData: frame.pixels.withUnsafeBufferPointer { Data(buffer: $0) },
      bytesPerRow: frame.width * 16, size: CGSize(width: frame.width, height: frame.height),
      format: .RGBAf, colorSpace: space)
  }

  private func crop(_ frame: Frame, _ r: CGRect) -> Frame {
    let pixels = (Int(r.minY)..<Int(r.maxY)).flatMap { y -> ArraySlice<Float> in
      let start = (y * frame.width + Int(r.minX)) * 4
      return frame.pixels[start..<(start + Int(r.width) * 4)]
    }
    return (pixels, Int(r.width), Int(r.height))
  }

  private func rgb(_ rgb: [UInt8], width: Int, _ r: CGRect) -> [UInt8] {
    (Int(r.minY)..<Int(r.maxY)).flatMap { y -> ArraySlice<UInt8> in
      let start = (y * width + Int(r.minX)) * 3
      return rgb[start..<(start + Int(r.width) * 3)]
    }
  }

  private func model() -> AdjustmentModel {
    var m = AdjustmentModel()
    m.profile = .neutral
    m.sharpenAmount = 0
    m.nrColor = 0
    m.nrLuminance = 0
    m.clarity = 80
    m.texture = 60
    m.dehaze = 70
    return m
  }

  /// The production windowed chain on `rect` of `frame`, recovering dehaze
  /// with `source`'s map, as top-down RGB8.
  private func patch(
    _ m: AdjustmentModel, frame: Frame, rect: CGRect, source: NativeDetailHazeSource,
    exports: DecodeExports = DecodeExports()
  ) throws -> [UInt8] {
    let size = CGSize(width: frame.width, height: frame.height)
    let halo = CGFloat(PipelineRenderer.sceneLinearChainWindowReach(model: m, fullSize: size))
    let grown = rect.insetBy(dx: -halo, dy: -halo).intersection(CGRect(origin: .zero, size: size))
    let rendered = try ImageEditPipeline().processSceneLinearWindow(
      decoded: image(crop(frame, grown)), hazeSource: source, model: m, origin: grown.origin,
      fullSize: size, asShot: nil, noiseProfile: nil, iso: exports.iso, wbFrame: exports.wbFrame,
      whitesAnchorEv: exports.whitesAnchorEv,
      encodePlan: .resolve(requested: .srgb, profileLUT: nil))
    // CoreImage is y-up: the rect's top row is the rendered extent's top.
    let bounds = CGRect(
      x: rect.minX - grown.minX, y: grown.maxY - rect.maxY, width: rect.width, height: rect.height)
    var rgba = [UInt8](repeating: 0, count: Int(rect.width * rect.height) * 4)
    rgba.withUnsafeMutableBytes {
      CIContext().render(
        rendered, toBitmap: $0.baseAddress!, rowBytes: Int(rect.width) * 4, bounds: bounds,
        format: .RGBA8, colorSpace: srgb)
    }
    return rgba.enumerated().filter { $0.offset % 4 != 3 }.map(\.element)
  }

  /// A GPU-live canvas holding `base`'s upload at `target`, the way
  /// `presentViaGpuLive` opens it and records the prescale.
  private func openCanvas(
    base: CIImage, target: CGSize, exports: DecodeExports, generation: UInt64
  ) async throws -> (driver: GpuLiveDriver, canvas: Frame) {
    let canvas = try XCTUnwrap(
      ImageEditPipeline().sceneLinearFloats(from: base, targetSize: target))
    let identity = GpuUploadIdentity(decodeGeneration: generation, crop: .identity)
    let driver = GpuLiveDriver()
    let pixels = canvas.pixels
    try await driver.open(
      width: canvas.width, height: canvas.height, identity: identity,
      whitesAnchorEv: exports.whitesAnchorEv, wbFrame: exports.wbFrame
    ) { pixels }
    driver.recordUploadedPrescale(target, identity: identity)
    return (driver, canvas)
  }

  private func meanAbsDiff(_ a: [UInt8], _ b: [UInt8]) -> Double {
    precondition(a.count == b.count)
    return Double(zip(a, b).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }) / Double(a.count)
  }

  private func deltaE(_ a: [UInt8], _ b: [UInt8]) throws -> CIEDE2000Result {
    let rgba = { (px: [UInt8]) -> [UInt8] in
      stride(from: 0, to: px.count, by: 3).flatMap { [px[$0], px[$0 + 1], px[$0 + 2], UInt8(255)] }
    }
    return try XCTUnwrap(
      CIEDE2000.compare(
        candidateRGBA: rgba(a), referenceRGBA: rgba(b), width: a.count / 3, height: 1))
  }

  // MARK: - Synthetic: the map against the GPU canvas's own

  /// A hazy scene: bright sky over ground whose fine texture the prescale
  /// averages away, under a uniform veil.
  private func scene(width: Int, height: Int) -> Frame {
    var out = [Float]()
    out.reserveCapacity(width * height * 4)
    for y in 0..<height {
      for x in 0..<width {
        let checker: Float = ((x / 2) + (y / 2)) % 2 == 0 ? 0.55 : 1.0
        let ripple = 0.5 + 0.5 * sin(Float(x) * 0.9) * cos(Float(y) * 0.7)
        let ground = 0.03 + 0.22 * checker * ripple * (x / 53 % 2 == 0 ? 1 : 0.3)
        let v: Float = y < height * 3 / 10 ? 1.2 : ground
        let veil: Float = 0.35
        out += [v * 1.04 + veil, v + veil * 1.02, v * 0.8 + veil * 1.08, 1]
      }
    }
    return (out, width, height)
  }

  /// The patch's map, measured from the canvas upload, recovers a window of
  /// that buffer as the GPU canvas does, within the GPU-vs-CPU chain budget;
  /// the decoded base's map, the pre-#5215 behaviour, lands further away.
  /// (Float-exactness against the CPU canvas chain is gated in CI by
  /// `NativeDetailWindowChainTests`; here the GPU's dither sets the floor.)
  func testPatchHazeMapFromTheGpuCanvasUploadMatchesTheCanvasRender() async throws {
    let base = image(scene(width: 1024, height: 768))
    let target = CGSize(width: 512, height: 384)
    let (driver, canvas) = try await openCanvas(
      base: base, target: target, exports: DecodeExports(), generation: 41)
    XCTAssertEqual(canvas.width, 512)
    XCTAssertNil(
      driver.canvasHazeSource(base: base, decodeGeneration: 42), "another decode is not this upload"
    )
    let source = try XCTUnwrap(driver.canvasHazeSource(base: base, decodeGeneration: 41))
    XCTAssertEqual(source.image.extent.size, CGSize(width: canvas.width, height: canvas.height))

    let m = model()
    let window = CGRect(x: 96, y: 200, width: 192, height: 128)
    let session = try XCTUnwrap(driver.session)
    let rendered = try await session.renderToBuffer(model: m, targetColorSpace: .srgb)
    let gpu = rgb(try XCTUnwrap(rendered), width: canvas.width, window)
    var undehazed = m
    undehazed.dehaze = 0
    let plainRender = try await session.renderToBuffer(model: undehazed, targetColorSpace: .srgb)
    let plain = rgb(try XCTUnwrap(plainRender), width: canvas.width, window)

    let fromCanvas = try patch(m, frame: canvas, rect: window, source: source)
    let fromBase = try patch(
      m, frame: canvas, rect: window, source: NativeDetailHazeSource(frame: base, targetSize: nil))
    let canvasDiff = meanAbsDiff(fromCanvas, gpu)
    let baseDiff = meanAbsDiff(fromBase, gpu)
    let canvasDE = try deltaE(fromCanvas, gpu)
    let baseDE = try deltaE(fromBase, gpu)
    print(
      "GPU-CANVAS-HAZE canvas-map mean=\(canvasDiff)/255 dE=\(canvasDE.meanDeltaE) p95=\(canvasDE.p95DeltaE)"
        + " | base-map mean=\(baseDiff)/255 dE=\(baseDE.meanDeltaE) p95=\(baseDE.p95DeltaE)"
        + " | dehaze moves the canvas \(meanAbsDiff(plain, gpu))/255")
    XCTAssertGreaterThan(meanAbsDiff(plain, gpu), 4, "dehaze must move the canvas render")
    // The CPU-refine-vs-GPU-live budget the GPU-live parity gates use
    // (MaskRemapRenderParityTests: < 1/255 mean).
    XCTAssertLessThan(canvasDiff, 1.0, "the canvas-measured map must match the GPU canvas")
    XCTAssertGreaterThan(baseDiff, canvasDiff, "the base map must part further from the canvas")
  }

  // MARK: - Real fixtures: patch vs canvas at the overlay boundary

  private static func fixture(_ name: String) -> URL? {
    var dir = URL(fileURLWithPath: #filePath)
    for _ in 0..<7 { dir.deleteLastPathComponent() }
    // A worktree under .claude/worktrees/ reads the main checkout's RAWs.
    let main = dir.deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
    for root in [dir, main] {
      let url = root.appendingPathComponent("test-fixtures/raws/\(name)")
      if FileManager.default.fileExists(atPath: url.path) { return url }
    }
    return nil
  }

  /// Linear-light 2×2 box average of top-down sRGB8, the canvas's grid at a
  /// half-resolution prescale.
  private func halve(_ rgb: [UInt8], width: Int, height: Int) -> [UInt8] {
    let lin = { (v: UInt8) -> Double in
      let s = Double(v) / 255
      return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
    }
    let enc = { (l: Double) -> UInt8 in
      let s = l <= 0.0031308 ? l * 12.92 : 1.055 * pow(l, 1 / 2.4) - 0.055
      return UInt8(min(max(s, 0), 1) * 255 + 0.5)
    }
    var out = [UInt8]()
    for y in stride(from: 0, to: height, by: 2) {
      for x in stride(from: 0, to: width, by: 2) {
        for c in 0..<3 {
          let taps = [(0, 0), (1, 0), (0, 1), (1, 1)].map {
            lin(rgb[((y + $0.1) * width + x + $0.0) * 3 + c])
          }
          out.append(enc(taps.reduce(0, +) / 4))
        }
      }
    }
    return out
  }

  /// The overlay's edge band: canvas pixels within `band` of the patch edge.
  private func ring(_ rgb: [UInt8], width: Int, height: Int, band: Int) -> [UInt8] {
    var out = [UInt8]()
    for y in 0..<height {
      for x in 0..<width where min(x, y, width - 1 - x, height - 1 - y) < band {
        out += rgb[(y * width + x) * 3..<(y * width + x) * 3 + 3]
      }
    }
    return out
  }

  /// #5215's evidence bar: a native-resolution patch (a window of the
  /// decoded base, as the capture tile is) recovered with the canvas
  /// upload's map vs with the base's map, each brought to the canvas grid
  /// and diffed (CIEDE2000) against the GPU canvas beneath it, over the
  /// whole patch and its edge band. Clarity and texture still part the two
  /// resolutions; the map is the term this issue owns, so the canvas map
  /// must not land further from the canvas than the base map.
  func testFixturePatchMeetsTheGpuCanvasAtTheOverlayBoundary() async throws {
    let names = ["test_0017.dng", "test_0006.DNG", "test_0013.DNG", "test_0002.dng"]
    let pipeline = ImageEditPipeline()
    var ran = 0
    for name in names {
      guard let url = Self.fixture(name),
        let decode = await pipeline.decodeSceneLinear(
          asset: AssetRef(url: url), quality: .preview, profileOverride: .neutral),
        let full = pipeline.sceneLinearFloats(from: decode.image, targetSize: nil)
      else { continue }
      ran += 1
      let exports = DecodeExports(
        iso: decode.iso, wbFrame: decode.wbFrame, whitesAnchorEv: decode.whitesAnchorEv)
      let target = CGSize(width: full.width / 2, height: full.height / 2)
      let (driver, canvas) = try await openCanvas(
        base: decode.image, target: target, exports: exports, generation: 7)
      let source = try XCTUnwrap(driver.canvasHazeSource(base: decode.image, decodeGeneration: 7))
      let m = decode.atAsShot(model())
      let gpuRender = try await XCTUnwrap(driver.session).renderToBuffer(
        model: m, wbFrame: decode.wbFrame, targetColorSpace: .srgb)
      let gpuFrame = try XCTUnwrap(gpuRender)

      // A 512×384 patch at the frame's centre, on even coordinates so it
      // lands on whole canvas pixels.
      let rect = CGRect(
        x: (full.width / 2 - 256) & ~1, y: (full.height / 2 - 192) & ~1, width: 512, height: 384)
      let onCanvas = CGRect(
        x: rect.minX / 2, y: rect.minY / 2, width: rect.width / 2, height: rect.height / 2)
      let gpu = rgb(gpuFrame, width: canvas.width, onCanvas)
      let (cw, ch) = (Int(onCanvas.width), Int(onCanvas.height))
      var results: [String: (whole: CIEDE2000Result, edge: CIEDE2000Result)] = [:]
      for (label, hazeSource) in [
        ("canvas-map", source),
        ("base-map", NativeDetailHazeSource(frame: decode.image, targetSize: nil)),
      ] {
        let native = try patch(m, frame: full, rect: rect, source: hazeSource, exports: exports)
        let down = halve(native, width: Int(rect.width), height: Int(rect.height))
        results[label] = (
          try deltaE(down, gpu),
          try deltaE(
            ring(down, width: cw, height: ch, band: 4), ring(gpu, width: cw, height: ch, band: 4))
        )
        let r = try XCTUnwrap(results[label])
        print(
          "GPU-CANVAS-HAZE-FIXTURE \(name) \(label): patch dE mean=\(r.whole.meanDeltaE) p95=\(r.whole.p95DeltaE)"
            + " | edge band dE mean=\(r.edge.meanDeltaE) p95=\(r.edge.p95DeltaE) max=\(r.edge.maxDeltaE)"
        )
      }
      let canvasEdge = try XCTUnwrap(results["canvas-map"]).edge.meanDeltaE
      let baseEdge = try XCTUnwrap(results["base-map"]).edge.meanDeltaE
      XCTAssertLessThanOrEqual(
        canvasEdge, baseEdge, "\(name): the canvas map must not part further")
    }
    if ran == 0 { throw XCTSkip("no fixture under test-fixtures/raws") }
  }
}
