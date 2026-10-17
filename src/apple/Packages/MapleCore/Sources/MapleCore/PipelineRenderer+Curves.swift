// PipelineRenderer+Curves.swift — #4738.
//
// `MapleAdjustmentParams` is scalars only: the point tone curves, the
// display-referred `crs:ToneCurvePV2012*` curves, the parametric regions and
// splits never reached the CPU chain Apple runs for refine, export and
// tiles, so a RAW exported on Apple lost every curve the live canvas showed.
// `ChainToneCurves` carries them over the curves-aware FFI entries, and
// `applyPerspective` applies the perspective correction raw-core's own
// `render` applies in `finish` but the scene-linear FFI path never did.

import Foundation
import RawPipeline

extension PipelineRenderer {
  /// Everything the chain needs from the model that the scalar params
  /// cannot carry. Flattened once at construction; bound into a
  /// `MapleToneCurves` for the duration of one FFI call.
  public struct ChainToneCurves: Sendable {
    let luma: [Float]
    let red: [Float]
    let green: [Float]
    let blue: [Float]
    let displayLuma: [Float]
    let displayRed: [Float]
    let displayGreen: [Float]
    let displayBlue: [Float]
    let mode: UInt32
    let parametricHighlights: Float
    let parametricLights: Float
    let parametricDarks: Float
    let parametricShadows: Float
    let parametricShadowSplit: Float
    let parametricMidtoneSplit: Float
    let parametricHighlightSplit: Float

    public init(model: AdjustmentModel) {
      luma = GpuLiveSession.flattened(model.toneCurveLuma)
      red = GpuLiveSession.flattened(model.toneCurveRed)
      green = GpuLiveSession.flattened(model.toneCurveGreen)
      blue = GpuLiveSession.flattened(model.toneCurveBlue)
      displayLuma = GpuLiveSession.flattened(model.displayToneCurveLuma)
      displayRed = GpuLiveSession.flattened(model.displayToneCurveRed)
      displayGreen = GpuLiveSession.flattened(model.displayToneCurveGreen)
      displayBlue = GpuLiveSession.flattened(model.displayToneCurveBlue)
      mode = model.toneCurveMode == .ratioPreserving ? 1 : 0
      parametricHighlights = Float(model.parametricHighlights)
      parametricLights = Float(model.parametricLights)
      parametricDarks = Float(model.parametricDarks)
      parametricShadows = Float(model.parametricShadows)
      parametricShadowSplit = Float(model.parametricShadowSplit)
      parametricMidtoneSplit = Float(model.parametricMidtoneSplit)
      parametricHighlightSplit = Float(model.parametricHighlightSplit)
    }

    /// True when the chain would render identically without curves — the
    /// caller can then keep the curve-less entry and its bit-exact output.
    public var isIdentity: Bool {
      let noCurves = [luma, red, green, blue, displayLuma, displayRed, displayGreen, displayBlue]
        .allSatisfy(\.isEmpty)
      let noRegions =
        parametricHighlights == 0 && parametricLights == 0 && parametricDarks == 0
        && parametricShadows == 0
      return noCurves && noRegions
    }

    func withMapleToneCurves<R>(
      _ body: (UnsafePointer<MapleToneCurves>) throws -> R
    ) rethrows -> R {
      let arrays = [luma, red, green, blue, displayLuma, displayRed, displayGreen, displayBlue]
      return try Self.withBufferPointers(arrays) { buffers in
        var c = MapleToneCurves()
        GpuLiveSession.bind(buffers[0], to: &c.luma_ptr, len: &c.luma_len)
        GpuLiveSession.bind(buffers[1], to: &c.red_ptr, len: &c.red_len)
        GpuLiveSession.bind(buffers[2], to: &c.green_ptr, len: &c.green_len)
        GpuLiveSession.bind(buffers[3], to: &c.blue_ptr, len: &c.blue_len)
        GpuLiveSession.bind(buffers[4], to: &c.display_luma_ptr, len: &c.display_luma_len)
        GpuLiveSession.bind(buffers[5], to: &c.display_red_ptr, len: &c.display_red_len)
        GpuLiveSession.bind(buffers[6], to: &c.display_green_ptr, len: &c.display_green_len)
        GpuLiveSession.bind(buffers[7], to: &c.display_blue_ptr, len: &c.display_blue_len)
        c.mode = mode
        c.parametric_highlights = parametricHighlights
        c.parametric_lights = parametricLights
        c.parametric_darks = parametricDarks
        c.parametric_shadows = parametricShadows
        c.parametric_shadow_split = parametricShadowSplit
        c.parametric_midtone_split = parametricMidtoneSplit
        c.parametric_highlight_split = parametricHighlightSplit
        return try withUnsafePointer(to: &c) { try body($0) }
      }
    }

    /// Nests `withUnsafeBufferPointer` over every array so all pointers
    /// stay valid for the whole of `body`.
    private static func withBufferPointers<R>(
      _ arrays: [[Float]], _ body: ([UnsafeBufferPointer<Float>]) throws -> R
    ) rethrows -> R {
      func recurse(_ index: Int, _ bound: [UnsafeBufferPointer<Float>]) throws -> R {
        guard index < arrays.count else { return try body(bound) }
        return try arrays[index].withUnsafeBufferPointer { try recurse(index + 1, bound + [$0]) }
      }
      return try recurse(0, [])
    }
  }

  /// `applyChainAndEncodeDisplayTarget` with the model's curves (#4738):
  /// routes through `maple_apply_chain_and_encode_display_target_curves_f32`.
  /// With `nil` or identity curves it is the curve-less entry, bit for bit.
  public static func applyChainAndEncodeDisplayTarget(
    inputBytes: Data,
    width: Int,
    height: Int,
    params: MapleAdjustmentParams,
    targetPrimaries: UInt32,
    curves: ChainToneCurves?,
    noiseProfile: [Float]? = nil,
    localAdjustments: [LocalAdjustment] = []
  ) throws -> Data {
    guard let curves, !curves.isIdentity else {
      return try applyChainAndEncodeDisplayTarget(
        inputBytes: inputBytes, width: width, height: height, params: params,
        targetPrimaries: targetPrimaries, noiseProfile: noiseProfile,
        localAdjustments: localAdjustments)
    }
    guard width > 0, height > 0 else {
      throw PipelineError.renderFailed(
        code: 2,
        message: "applyChainAndEncodeDisplayTarget: zero dimension width=\(width) height=\(height)"
      )
    }
    let lanes = width * height * 4
    let expectedBytes = lanes * MemoryLayout<Float>.size
    guard inputBytes.count == expectedBytes else {
      throw PipelineError.renderFailed(
        code: 9,
        message:
          "applyChainAndEncodeDisplayTarget: input \(inputBytes.count) bytes != expected \(expectedBytes)"
      )
    }
    var output = Data(count: expectedBytes)
    let rc: Int32 = try withChainPointers(
      params, noiseProfile: noiseProfile, localAdjustments: localAdjustments
    ) { bound in
      var p = bound
      return try curves.withMapleToneCurves { curvesPtr in
        try output.withUnsafeMutableBytes { outBuf -> Int32 in
          let outPtr = outBuf.bindMemory(to: Float.self).baseAddress!
          return inputBytes.withUnsafeBytes { inBuf -> Int32 in
            let inPtr = inBuf.bindMemory(to: Float.self).baseAddress!
            return maple_apply_chain_and_encode_display_target_curves_f32(
              inPtr, UInt32(width), UInt32(height), &p, curvesPtr, targetPrimaries, outPtr)
          }
        }
      }
    }
    guard rc == 0 else {
      let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
      throw PipelineError.renderFailed(code: Int(rc), message: msg)
    }
    return output
  }

  /// Applies the model's perspective correction to an f32 RGBA buffer
  /// (`maple_apply_perspective_f32`), the same warp raw-core's `finish`
  /// stage and the GPU-live present use. Identity returns the input.
  public static func applyPerspective(
    bytes: Data, width: Int, height: Int, perspective: Perspective
  ) throws -> Data {
    guard !perspective.isIdentity else { return bytes }
    guard width > 0, height > 0 else {
      throw PipelineError.renderFailed(
        code: 2, message: "applyPerspective: zero dimension width=\(width) height=\(height)")
    }
    let expectedBytes = width * height * 4 * MemoryLayout<Float>.size
    guard bytes.count == expectedBytes else {
      throw PipelineError.renderFailed(
        code: 9,
        message: "applyPerspective: input \(bytes.count) bytes != expected \(expectedBytes)"
      )
    }
    var output = Data(count: expectedBytes)
    let rc: Int32 = output.withUnsafeMutableBytes { outBuf -> Int32 in
      let outPtr = outBuf.bindMemory(to: Float.self).baseAddress!
      return bytes.withUnsafeBytes { inBuf -> Int32 in
        let inPtr = inBuf.bindMemory(to: Float.self).baseAddress!
        return maple_apply_perspective_f32(
          inPtr, UInt32(width), UInt32(height),
          Float(perspective.vertical), Float(perspective.horizontal), Float(perspective.rotate),
          Float(perspective.scale), Float(perspective.aspect), Float(perspective.x),
          Float(perspective.y), outPtr)
      }
    }
    guard rc == 0 else {
      let msg = maple_last_error().map { String(cString: $0) } ?? "unknown error"
      throw PipelineError.renderFailed(code: Int(rc), message: msg)
    }
    return output
  }
}
