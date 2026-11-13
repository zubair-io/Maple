// ChainCurvesWiringTests.swift — #4738: the Apple CPU chain (refine,
// export, tiles) now carries the model's tone curves, parametric regions,
// WB method and perspective over the FFI, matching the live canvas.

import RawPipeline
import XCTest

@testable import MapleCore

final class ChainCurvesWiringTests: XCTestCase {

  private func ramp(width: Int) -> Data {
    var input = [Float](repeating: 0, count: width * 4)
    for x in 0..<width {
      let v = Float(x) / Float(width - 1)
      input[x * 4] = v
      input[x * 4 + 1] = v
      input[x * 4 + 2] = v
      input[x * 4 + 3] = 1
    }
    return input.withUnsafeBufferPointer { Data(buffer: $0) }
  }

  private func floats(_ data: Data) -> [Float] {
    data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
  }

  private var quietModel: AdjustmentModel {
    var model = AdjustmentModel.default
    model.sharpenAmount = 0
    model.nrColor = 0
    return model
  }

  func testMakeParamsCarriesWbMethod() {
    var model = AdjustmentModel.default
    XCTAssertEqual(PipelineRenderer.makeParams(from: model).wb_method, 0)
    model.wbMethod = .diagonalRec2020
    XCTAssertEqual(PipelineRenderer.makeParams(from: model).wb_method, 1)
  }

  func testChainToneCurvesFlattensEveryCurveAndCarriesParametrics() {
    var model = AdjustmentModel.default
    model.toneCurveLuma = ToneCurve(points: [(x: 0, y: 0), (x: 0.5, y: 0.7), (x: 1, y: 1)])
    model.displayToneCurveRed = ToneCurve(points: [(x: 0, y: 0.1), (x: 1, y: 1)])
    model.toneCurveMode = .ratioPreserving
    model.parametricShadows = -30
    model.parametricHighlightSplit = 80

    let curves = PipelineRenderer.ChainToneCurves(model: model)

    XCTAssertFalse(curves.isIdentity)
    XCTAssertEqual(curves.luma, [0, 0, 0.5, 0.7, 1, 1])
    XCTAssertEqual(curves.displayRed, [0, 0.1, 1, 1])
    XCTAssertTrue(curves.red.isEmpty)
    XCTAssertEqual(curves.mode, 1)
    XCTAssertEqual(curves.parametricShadows, -30)
    XCTAssertEqual(curves.parametricHighlightSplit, 80)
    curves.withMapleToneCurves { c in
      XCTAssertEqual(c.pointee.luma_len, 6)
      XCTAssertEqual(c.pointee.display_red_len, 4)
      XCTAssertNil(c.pointee.red_ptr)
      XCTAssertEqual(c.pointee.red_len, 0)
      XCTAssertEqual(c.pointee.mode, 1)
      XCTAssertEqual(c.pointee.parametric_shadows, -30)
      XCTAssertEqual(c.pointee.parametric_midtone_split, 50)
    }
  }

  func testDefaultModelCurvesAreIdentity() {
    XCTAssertTrue(PipelineRenderer.ChainToneCurves(model: .default).isIdentity)
  }

  func testIdentityCurvesMatchTheCurvelessEntryBitForBit() throws {
    let width = 256
    let input = ramp(width: width)
    let params = PipelineRenderer.makeParams(from: quietModel)
    let plain = try PipelineRenderer.applyChainAndEncodeDisplayTarget(
      inputBytes: input, width: width, height: 1, params: params, targetPrimaries: 1)
    let withCurves = try PipelineRenderer.applyChainAndEncodeDisplayTarget(
      inputBytes: input, width: width, height: 1, params: params, targetPrimaries: 1,
      curves: PipelineRenderer.ChainToneCurves(model: quietModel))
    XCTAssertEqual(plain, withCurves)
  }

  func testPointCurveChangesTheP3EncodedOutput() throws {
    let width = 256
    let input = ramp(width: width)
    var model = quietModel
    let params = PipelineRenderer.makeParams(from: model)
    let plain = try PipelineRenderer.applyChainAndEncodeDisplayTarget(
      inputBytes: input, width: width, height: 1, params: params, targetPrimaries: 1,
      curves: nil)
    model.toneCurveLuma = ToneCurve(points: [(x: 0, y: 0), (x: 0.5, y: 0.2), (x: 1, y: 1)])
    let curved = try PipelineRenderer.applyChainAndEncodeDisplayTarget(
      inputBytes: input, width: width, height: 1, params: params, targetPrimaries: 1,
      curves: PipelineRenderer.ChainToneCurves(model: model))

    let a = floats(plain)
    let b = floats(curved)
    XCTAssertEqual(a.count, b.count)
    let mid = width / 2 * 4
    XCTAssertLessThan(b[mid], a[mid] - 0.01, "a pulled-down luma curve must darken the midtone")
  }

  func testParametricRegionChangesTheP3EncodedOutput() throws {
    let width = 256
    let input = ramp(width: width)
    var model = quietModel
    let params = PipelineRenderer.makeParams(from: model)
    let plain = try PipelineRenderer.applyChainAndEncodeDisplayTarget(
      inputBytes: input, width: width, height: 1, params: params, targetPrimaries: 1,
      curves: nil)
    model.parametricShadows = -80
    let shaped = try PipelineRenderer.applyChainAndEncodeDisplayTarget(
      inputBytes: input, width: width, height: 1, params: params, targetPrimaries: 1,
      curves: PipelineRenderer.ChainToneCurves(model: model))
    XCTAssertNotEqual(plain, shaped, "parametric shadows must reach the chain")
  }

  func testPerspectiveIdentityReturnsInputUnchanged() throws {
    let input = ramp(width: 8)
    let out = try PipelineRenderer.applyPerspective(
      bytes: input, width: 8, height: 1, perspective: .identity)
    XCTAssertEqual(out, input)
  }

  func testPerspectiveRotationMovesPixels() throws {
    let width = 16
    let height = 16
    var input = [Float](repeating: 0, count: width * height * 4)
    for y in 0..<height {
      for x in 0..<width {
        let i = (y * width + x) * 4
        input[i] = x < width / 2 ? 1 : 0
        input[i + 1] = input[i]
        input[i + 2] = input[i]
        input[i + 3] = 1
      }
    }
    let bytes = input.withUnsafeBufferPointer { Data(buffer: $0) }
    var perspective = Perspective.identity
    perspective.rotate = 45
    let out = try PipelineRenderer.applyPerspective(
      bytes: bytes, width: width, height: height, perspective: perspective)
    XCTAssertEqual(out.count, bytes.count)
    XCTAssertNotEqual(out, bytes, "a 45° rotation must move the half-plane edge")
  }

  func testPerspectiveRejectsWrongByteCount() {
    XCTAssertThrowsError(
      try PipelineRenderer.applyPerspective(
        bytes: Data(count: 4), width: 8, height: 1, perspective: .init(rotate: 10)))
  }

  func testGpuLiveParamsBindDisplayCurves() {
    var buffers = GpuColorCurveBuffers()
    var model = AdjustmentModel.default
    model.displayToneCurveLuma = ToneCurve(points: [(x: 0, y: 0), (x: 1, y: 0.5)])
    model.displayToneCurveBlue = ToneCurve(points: [(x: 0.2, y: 0.3)])
    let base = MapleGpuLiveParams()

    GpuLiveSession.withDisplayCurvesBound(base, model, buffers: &buffers) { p in
      XCTAssertEqual(p.display_tone_curve_luma_len, 4)
      XCTAssertEqual(p.display_tone_curve_luma_ptr?[3], 0.5)
      XCTAssertEqual(p.display_tone_curve_blue_len, 2)
      XCTAssertEqual(p.display_tone_curve_blue_ptr?[0], 0.2)
      XCTAssertNil(p.display_tone_curve_red_ptr)
      XCTAssertEqual(p.display_tone_curve_green_len, 0)
    }
    GpuLiveSession.withDisplayCurvesBound(base, .default, buffers: &buffers) { p in
      XCTAssertNil(p.display_tone_curve_luma_ptr)
      XCTAssertEqual(p.display_tone_curve_luma_len, 0)
    }
  }
}
