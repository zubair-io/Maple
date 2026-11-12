// NativeDetailWindowChainTests.swift — #5169, #3287.
//
// The 100% patch must render its interior exactly like the same pixels of
// the full-frame chain. Driven through the same `PipelineRenderer` calls
// production makes: the reach query sizes the halo, the windowed entry
// renders the grown patch, the whole-frame target entry is the reference.

import CoreGraphics
import XCTest

@testable import MapleCore

final class NativeDetailWindowChainTests: XCTestCase {
  private let full = (w: 960, h: 640)
  private let patch = CGRect(x: 300, y: 220, width: 128, height: 96)

  private func frame() -> [Float] {
    var out = [Float]()
    out.reserveCapacity(full.w * full.h * 4)
    for y in 0..<full.h {
      for x in 0..<full.w {
        let sky: Float = Double(y) < 0.4 * Double(full.h) ? 1.6 : 0.06
        let block: Float = (x / 37) % 3 == 0 ? 0.5 : 1.0
        let ripple = 0.08 * sin(Float(x) * 0.31) * cos(Float(y) * 0.17)
        let v = max(sky * block + ripple, 0.002)
        out += [v * 1.05, v, v * 0.82, 1]
      }
    }
    return out
  }

  private func crop(_ px: [Float], width: Int, _ r: CGRect) -> [Float] {
    (Int(r.minY)..<Int(r.maxY)).flatMap { y -> ArraySlice<Float> in
      let start = (y * width + Int(r.minX)) * 4
      return px[start..<(start + Int(r.width) * 4)]
    }
  }

  private func data(_ px: [Float]) -> Data { px.withUnsafeBufferPointer { Data(buffer: $0) } }
  private func floats(_ d: Data) -> [Float] {
    d.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
  }

  private func model(highlights: Double = 0, shadows: Double = 0, clarity: Double = 0)
    -> AdjustmentModel
  {
    var m = AdjustmentModel()
    m.sharpenAmount = 0
    m.nrColor = 0
    m.nrLuminance = 0
    m.highlights = highlights
    m.shadows = shadows
    m.clarity = clarity
    m.localAdjustments = [
      LocalAdjustment(
        mask: .radial(
          center: MaskPoint(x: 0.35, y: 0.4), radii: MaskPoint(x: 0.2, y: 0.25),
          angle: 0.3, feather: 0.5, invert: false),
        adjustments: PartialAdjustments(exposure: 1.0))
    ]
    return m
  }

  private func render(_ m: AdjustmentModel, target: CanvasColorSpace, withHaze: Bool = false)
    throws -> (
      full: [Float], window: [Float], halo: Int
    )
  {
    let fullSize = CGSize(width: full.w, height: full.h)
    let params = PipelineRenderer.makeParams(from: m, whitesAnchorEv: 0)
    let source = frame()
    let whole = try PipelineRenderer.applyChainAndEncodeDisplayTarget(
      inputBytes: data(source), width: full.w, height: full.h, params: params,
      targetPrimaries: target.wireValue, curves: PipelineRenderer.ChainToneCurves(model: m),
      localAdjustments: m.localAdjustments)
    let haze =
      withHaze
      ? try PipelineRenderer.sceneLinearHazeMap(
        frameBytes: data(source), width: full.w, height: full.h, params: params,
        curves: PipelineRenderer.ChainToneCurves(model: m), noiseProfile: nil,
        localAdjustments: m.localAdjustments)
      : nil
    let halo = PipelineRenderer.sceneLinearChainWindowReach(model: m, fullSize: fullSize)
    let grown = patch.insetBy(dx: -CGFloat(halo), dy: -CGFloat(halo))
      .intersection(CGRect(origin: .zero, size: fullSize))
    let rendered = try PipelineRenderer.applyChainAndEncodeDisplayTargetWindow(
      inputBytes: data(crop(source, width: full.w, grown)),
      width: Int(grown.width), height: Int(grown.height), params: params,
      targetPrimaries: target.wireValue, curves: PipelineRenderer.ChainToneCurves(model: m),
      noiseProfile: nil, localAdjustments: m.localAdjustments,
      window: PipelineRenderer.chainWindow(origin: grown.origin, fullSize: fullSize),
      haze: haze)
    let inner = patch.offsetBy(dx: -grown.minX, dy: -grown.minY)
    return (
      crop(floats(whole), width: full.w, patch),
      crop(floats(rendered), width: Int(grown.width), inner),
      halo
    )
  }

  private func maxAbs(_ a: [Float], _ b: [Float]) -> Float {
    zip(a, b).reduce(0) { max($0, abs($1.0 - $1.1)) }
  }

  func testHaloCoversTheFrameScaledSHMaskAndClarity() {
    let size = CGSize(width: full.w, height: full.h)
    // σ = 15 px · 960/2000 → round(3σ) = 22 px per engaged S/H pass.
    XCTAssertEqual(PipelineRenderer.sceneLinearChainWindowReach(model: model(), fullSize: size), 0)
    XCTAssertEqual(
      PipelineRenderer.sceneLinearChainWindowReach(
        model: model(highlights: -60, shadows: 60), fullSize: size), 44)
    XCTAssertEqual(
      PipelineRenderer.sceneLinearChainWindowReach(
        model: model(highlights: -60, shadows: 60, clarity: 60), fullSize: size), 84)
  }

  func testWindowedPatchMatchesTheFullFrameForSHAndClarity() throws {
    for (name, m) in [
      ("S/H", model(highlights: -60, shadows: 60)),
      ("clarity", model(clarity: 60)),
      ("S/H + clarity", model(highlights: -60, shadows: 60, clarity: 60)),
    ] {
      for target in [CanvasColorSpace.srgb, .displayP3] {
        let (whole, window, halo) = try render(m, target: target)
        XCTAssertGreaterThan(halo, 0)
        let neutral = try render(model(), target: target).full
        XCTAssertGreaterThan(maxAbs(whole, neutral), 1e-2, "\(name): the case must move the render")
        XCTAssertLessThanOrEqual(maxAbs(whole, window), 1e-4, "\(name) \(target)")
      }
    }
  }

  func testWindowedChainRefusesDehazeWithoutTheFrameHazeMap() {
    var m = model()
    m.dehaze = 40
    XCTAssertThrowsError(try render(m, target: .srgb))
  }

  /// #3287: with the whole frame's haze maps the patch dehazes exactly like
  /// the full frame — global and per mask.
  func testWindowedPatchMatchesTheFullFrameForDehazeWithTheFrameHazeMap() throws {
    var global = model(clarity: 30)
    global.dehaze = 45
    var masked = model()
    masked.localAdjustments[0].adjustments.dehaze = -40
    for (name, m) in [("global", global), ("per-mask", masked)] {
      let (whole, window, _) = try render(m, target: .srgb, withHaze: true)
      let undehazed = try render(model(clarity: name == "global" ? 30 : 0), target: .srgb).full
      XCTAssertGreaterThan(maxAbs(whole, undehazed), 1e-2, "\(name): dehaze must move the render")
      XCTAssertLessThanOrEqual(maxAbs(whole, window), 1e-4, name)
    }
    XCTAssertNil(
      try PipelineRenderer.sceneLinearHazeMap(
        frameBytes: data(frame()), width: full.w, height: full.h,
        params: PipelineRenderer.makeParams(from: model(), whitesAnchorEv: 0),
        curves: PipelineRenderer.ChainToneCurves(model: model()), noiseProfile: nil,
        localAdjustments: model().localAdjustments),
      "no dehaze, no map")
  }

  /// #3287, #5215: a pan or a dehaze move reuses the patch's haze map without
  /// rendering the decoded frame again; an upstream edit, or the same frame
  /// at another prescale target (the GPU canvas's upload), measures anew.
  func testHazeMapCacheHitRendersNoFrameCopy() throws {
    let pixels = frame()
    let image = CIImage(
      bitmapData: data(pixels), bytesPerRow: full.w * 16,
      size: CGSize(width: full.w, height: full.h), format: .RGBAf,
      colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!)
    let pipeline = ImageEditPipeline()
    let map = { (m: AdjustmentModel, target: CGSize?) in
      try pipeline.hazeMap(
        source: NativeDetailHazeSource(frame: image, targetSize: target), model: m,
        params: PipelineRenderer.makeParams(from: m, whitesAnchorEv: 0),
        curves: PipelineRenderer.ChainToneCurves(model: m), noiseProfile: nil)
    }
    var m = model()
    m.dehaze = 30
    let before = NativeDetailHazeCache.shared.measurements
    let first = try XCTUnwrap(try map(m, nil))
    m.dehaze = -60
    m.sharpenAmount = 70
    XCTAssertTrue(try XCTUnwrap(try map(m, nil)) === first, "a dehaze move must reuse the map")
    XCTAssertEqual(NativeDetailHazeCache.shared.measurements, before + 1)
    let canvas = CGSize(width: full.w / 2, height: full.h / 2)
    let prescaled = try XCTUnwrap(try map(m, canvas))
    XCTAssertFalse(prescaled === first, "the canvas upload's map is measured from that buffer")
    XCTAssertTrue(try XCTUnwrap(try map(m, canvas)) === prescaled, "and reused like any other")
    XCTAssertEqual(NativeDetailHazeCache.shared.measurements, before + 2)
    m.exposure = 0.6
    XCTAssertFalse(
      try XCTUnwrap(try map(m, canvas)) === prescaled, "an upstream edit must measure anew")
    XCTAssertEqual(NativeDetailHazeCache.shared.measurements, before + 3)
  }

  /// #5215: with the GPU-live canvas's upload as its haze source, a window
  /// of that buffer dehazes exactly like the whole-canvas chain, which
  /// measures its own map from the same pixels; the full-resolution decoded
  /// base's map (the pre-#5215 source) does not, because clarity and
  /// texture do not commute with the prescale.
  func testWindowWithTheCanvasUploadHazeSourceMatchesTheCanvasChain() throws {
    let image = CIImage(
      bitmapData: data(frame()), bytesPerRow: full.w * 16,
      size: CGSize(width: full.w, height: full.h), format: .RGBAf,
      colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!)
    let target = CGSize(width: full.w / 2, height: full.h / 2)
    let pipeline = ImageEditPipeline()
    let canvas = try XCTUnwrap(pipeline.sceneLinearFloats(from: image, targetSize: target))
    let size = CGSize(width: canvas.width, height: canvas.height)
    var m = model(clarity: 60)
    m.texture = 50
    m.dehaze = 45
    let params = PipelineRenderer.makeParams(from: m, whitesAnchorEv: 0)
    let curves = PipelineRenderer.ChainToneCurves(model: m)
    let window = CGRect(x: 150, y: 110, width: 64, height: 48)
    let whole = crop(
      floats(
        try PipelineRenderer.applyChainAndEncodeDisplayTarget(
          inputBytes: data(canvas.pixels), width: canvas.width, height: canvas.height,
          params: params, targetPrimaries: CanvasColorSpace.srgb.wireValue, curves: curves,
          localAdjustments: m.localAdjustments)),
      width: canvas.width, window)
    let halo = CGFloat(PipelineRenderer.sceneLinearChainWindowReach(model: m, fullSize: size))
    let grown = window.insetBy(dx: -halo, dy: -halo).intersection(CGRect(origin: .zero, size: size))
    let render = { (source: NativeDetailHazeSource) throws -> [Float] in
      let haze = try pipeline.hazeMap(
        source: source, model: m, params: params, curves: curves, noiseProfile: nil)
      let rendered = try PipelineRenderer.applyChainAndEncodeDisplayTargetWindow(
        inputBytes: self.data(self.crop(canvas.pixels, width: canvas.width, grown)),
        width: Int(grown.width), height: Int(grown.height), params: params,
        targetPrimaries: CanvasColorSpace.srgb.wireValue, curves: curves, noiseProfile: nil,
        localAdjustments: m.localAdjustments,
        window: PipelineRenderer.chainWindow(origin: grown.origin, fullSize: size), haze: haze)
      return self.crop(
        self.floats(rendered), width: Int(grown.width),
        window.offsetBy(dx: -grown.minX, dy: -grown.minY))
    }
    let fromCanvas = try render(NativeDetailHazeSource(frame: image, targetSize: target))
    let fromBase = try render(NativeDetailHazeSource(frame: image, targetSize: nil))
    print(
      "CANVAS-HAZE-CPU canvas-map maxAbs=\(maxAbs(whole, fromCanvas)) base-map maxAbs=\(maxAbs(whole, fromBase))"
    )
    XCTAssertLessThanOrEqual(maxAbs(whole, fromCanvas), 1e-4, "the canvas upload's map")
    XCTAssertGreaterThan(maxAbs(whole, fromBase), 1e-3, "the base's map must part from it")
  }

  func testDecodeRectWidensToTheChainReach() {
    let detail = CGRect(x: 6000, y: 3500, width: 1200, height: 900)
    let size = CGSize(width: 13000, height: 8000)
    XCTAssertEqual(
      NativeDetailLOD.decodeRect(detailRect: detail, imageSize: size, halo: 40),
      NativeDetailLOD.decodeRect(
        detailRect: detail, imageSize: size, halo: NativeDetailLOD.filterHalo))
    XCTAssertEqual(
      NativeDetailLOD.decodeRect(detailRect: detail, imageSize: size, halo: 552),
      CGRect(x: 5448, y: 2948, width: 2304, height: 2004))
  }
}
