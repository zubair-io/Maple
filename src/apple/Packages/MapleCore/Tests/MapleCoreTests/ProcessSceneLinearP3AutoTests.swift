// ProcessSceneLinearP3AutoTests.swift — #4741.
//
// On a Display P3 canvas an Auto render takes raw-core's P3 Auto encode (the
// tail inside the encode, no sRGB cube afterwards); an sRGB canvas or a film
// override keeps the sRGB encode + cube, and an export encodes to its
// format's primaries rather than the canvas. Fixture-free: synthetic scene-linear
// input and a synthetic lattice.

import CoreImage
import XCTest
@testable import MapleCore

final class ProcessSceneLinearP3AutoTests: XCTestCase {
  private static let stateLock = NSLock()

  private func withCanvasColorSpace(_ cs: CanvasColorSpace, _ body: () throws -> Void) rethrows {
    Self.stateLock.lock()
    defer { Self.stateLock.unlock() }
    let saved = UserDefaults.standard.object(forKey: CanvasColorSpace.defaultsKey)
    UserDefaults.standard.set(cs.rawValue, forKey: CanvasColorSpace.defaultsKey)
    defer {
      if let saved {
        UserDefaults.standard.set(saved, forKey: CanvasColorSpace.defaultsKey)
      } else {
        UserDefaults.standard.removeObject(forKey: CanvasColorSpace.defaultsKey)
      }
    }
    try body()
  }

  private static func lattice(dimension n: Int, warmth: Float) -> [Float] {
    (0..<(n * n * n)).flatMap { i -> [Float] in
      let (r, g, b) = (i % n, (i / n) % n, i / (n * n))
      let rgb = [r, g, b].map { Float($0) / Float(n - 1) }
      return [rgb[0] + warmth, rgb[1], rgb[2] - warmth].map { min(max($0, 0), 1) }
    }
  }

  private static func filter(_ lut: [Float], dimension: Int) throws -> CIFilter {
    let cube = try XCTUnwrap(AutoProfileLUT.buildCubeFromLUT(lut, dimension: dimension))
    return try XCTUnwrap(AutoProfileLUT.makeFilter(from: cube))
  }

  private static func pixels(_ image: CIImage) -> [Float] {
    let extent = image.extent.integral
    let (w, h) = (Int(extent.width), Int(extent.height))
    var out = [Float](repeating: 0, count: w * h * 4)
    out.withUnsafeMutableBytes { buf in
      CIContext(options: [.workingColorSpace: NSNull()]).render(
        image, toBitmap: buf.baseAddress!, rowBytes: w * 16, bounds: extent, format: .RGBAf,
        colorSpace: image.colorSpace)
    }
    return out
  }

  func testLatticeRoundTripsThroughTheCubeFilter() throws {
    let lut = Self.lattice(dimension: 9, warmth: 0.04)
    let minted = try Self.filter(lut, dimension: 9)
    let copied = try XCTUnwrap(minted.copy() as? CIFilter)
    for filter in [minted, copied] {
      let lattice = try XCTUnwrap(AutoProfileLUT.lattice(of: filter))
      XCTAssertEqual(lattice.dimension, 9)
      XCTAssertEqual(lattice.rgb, lut)
    }
  }

  /// A cache hit mints a fresh filter per render from the same cached cube;
  /// every one must hand back the cached lattice storage, not a repack.
  func testFiltersMintedFromOneCubeShareItsLatticeStorage() throws {
    let cube = try XCTUnwrap(
      AutoProfileLUT.buildCubeFromLUT(Self.lattice(dimension: 9, warmth: 0.04), dimension: 9))
    let first = try XCTUnwrap(AutoProfileLUT.makeFilter(from: cube))
    let second = try XCTUnwrap(AutoProfileLUT.makeFilter(from: cube))
    XCTAssertFalse(first === second)
    let storage = { (filter: CIFilter) throws -> UnsafePointer<Float>? in
      try XCTUnwrap(AutoProfileLUT.lattice(of: filter)).rgb
        .withUnsafeBufferPointer { $0.baseAddress }
    }
    let cached = cube.lattice.rgb.withUnsafeBufferPointer { $0.baseAddress }
    XCTAssertEqual(try storage(first), cached)
    XCTAssertEqual(try storage(second), cached)
  }

  func testP3CanvasTakesTheP3AutoRouteAndSRGBStaysOnTheCube() throws {
    let pipeline = ImageEditPipeline()
    let input = SceneLinearPipelineTests.makeNeutralSceneLinearCIImage(
      width: 16, height: 16, value: 0.4)
    let cube = try Self.filter(Self.lattice(dimension: 9, warmth: 0.04), dimension: 9)
    try withCanvasColorSpace(.displayP3) {
      let p3 = pipeline.processSceneLinear(
        decoded: input, model: AdjustmentModel.default, profileLUT: cube)
      XCTAssertEqual(p3.colorSpace?.name as String?, CGColorSpace.displayP3 as String)
      let film = pipeline.processSceneLinear(
        decoded: input, model: AdjustmentModel.default, profileLUT: cube,
        targetPrimariesOverride: .srgb)
      XCTAssertEqual(film.colorSpace?.name as String?, CGColorSpace.sRGB as String)
    }
    try withCanvasColorSpace(.srgb) {
      let srgb = pipeline.processSceneLinear(
        decoded: input, model: AdjustmentModel.default, profileLUT: cube)
      XCTAssertEqual(srgb.colorSpace?.name as String?, CGColorSpace.sRGB as String)
    }
  }

  /// An export encodes to its format's primaries whatever the canvas is, so
  /// an sRGB file from a P3 canvas is gamut-compressed in the encode instead
  /// of clipped at the format conversion, and a P3 file from an sRGB canvas
  /// keeps the wide gamut.
  func testExportFormatPrimariesOverrideTheCanvas() throws {
    let expected: [ExportFileFormat: CanvasColorSpace] = [
      .jpegSRGB: .srgb, .jpegP3: .displayP3, .heicP3: .displayP3, .tiff16: .srgb, .png: .srgb,
    ]
    XCTAssertEqual(Set(expected.keys), Set(ExportFileFormat.allCases))
    for (format, primaries) in expected {
      XCTAssertEqual(format.encodePrimaries, primaries, "\(format)")
    }
    let pipeline = ImageEditPipeline()
    let input = SceneLinearPipelineTests.makeNeutralSceneLinearCIImage(
      width: 16, height: 16, value: 0.4)
    let cube = try Self.filter(Self.lattice(dimension: 9, warmth: 0.04), dimension: 9)
    for (canvas, format, tag) in [
      (CanvasColorSpace.displayP3, ExportFileFormat.png, CGColorSpace.sRGB),
      (.srgb, .heicP3, CGColorSpace.displayP3),
    ] {
      try withCanvasColorSpace(canvas) {
        let exported = pipeline.processSceneLinear(
          decoded: input, model: AdjustmentModel.default, profileLUT: cube,
          targetPrimariesOverride: format.encodePrimaries)
        XCTAssertEqual(exported.colorSpace?.name as String?, tag as String, "\(format)")
      }
    }
  }

  /// An identity lattice on the P3 route must land on Neutral's P3 render: the
  /// tail ran once, inside the encode, and no cube was applied on top.
  func testIdentityLatticeOnP3MatchesNeutralP3() throws {
    let pipeline = ImageEditPipeline()
    let input = SceneLinearPipelineTests.makeNeutralSceneLinearCIImage(
      width: 8, height: 8, value: 0.3)
    try withCanvasColorSpace(.displayP3) {
      let identity = try Self.filter(Self.lattice(dimension: 17, warmth: 0), dimension: 17)
      let auto = Self.pixels(
        pipeline.processSceneLinear(
          decoded: input, model: AdjustmentModel.default, profileLUT: identity))
      let neutral = Self.pixels(
        pipeline.processSceneLinear(decoded: input, model: AdjustmentModel.default))
      let maxDiff = zip(auto, neutral).map { abs($0 - $1) }.max() ?? .infinity
      XCTAssertLessThan(maxDiff, 1e-3)
      let warm = try Self.filter(Self.lattice(dimension: 17, warmth: 0.05), dimension: 17)
      let warmed = Self.pixels(
        pipeline.processSceneLinear(
          decoded: input, model: AdjustmentModel.default, profileLUT: warm))
      XCTAssertGreaterThan(warmed[0], auto[0] + 0.01, "the tail must reach the P3 render")
    }
  }
}
