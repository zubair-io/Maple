// PipelineRenderer+Window.swift — #5169.
//
// The 100% native-detail patch is a crop of the frame. Run through the
// whole-buffer chain, its S/H mask was sized from the patch and dehaze
// measured haze from the patch alone. These wrappers drive the windowed
// chain instead: every frame-scaled or frame-anchored stage sees the full
// frame, and the patch is grown by the chain's reported reach.

import CoreGraphics
import Foundation
import RawPipeline

extension PipelineRenderer {
  static func chainWindow(origin: CGPoint, fullSize: CGSize) -> MapleChainWindow {
    MapleChainWindow(
      x: UInt32(max(0, origin.x.rounded())),
      y: UInt32(max(0, origin.y.rounded())),
      full_width: UInt32(max(0, fullSize.width.rounded())),
      full_height: UInt32(max(0, fullSize.height.rounded()))
    )
  }

  /// Context, in source pixels per edge, a patch must carry so the windowed
  /// chain reproduces the full-frame chain for `model` on a frame of
  /// `fullSize` (`maple_scene_linear_chain_window_reach_px`).
  public static func sceneLinearChainWindowReach(model: AdjustmentModel, fullSize: CGSize) -> Int {
    var window = chainWindow(origin: .zero, fullSize: fullSize)
    let params = makeParams(from: model)
    return withChainPointers(params, noiseProfile: nil, localAdjustments: model.localAdjustments) {
      bound in
      var p = bound
      return Int(maple_scene_linear_chain_window_reach_px(&p, &window))
    }
  }

  /// `applyChainAndEncodeDisplayTarget` for a patch at `window` in the full
  /// frame (`maple_apply_chain_and_encode_display_target_window_f32`).
  /// Throws for dehaze, which needs the whole frame.
  public static func applyChainAndEncodeDisplayTargetWindow(
    inputBytes: Data,
    width: Int,
    height: Int,
    params: MapleAdjustmentParams,
    targetPrimaries: UInt32,
    curves: ChainToneCurves,
    noiseProfile: [Float]?,
    localAdjustments: [LocalAdjustment],
    window: MapleChainWindow
  ) throws -> Data {
    guard width > 0, height > 0 else {
      throw PipelineError.renderFailed(
        code: 2, message: "applyChainAndEncodeDisplayTargetWindow: zero dimension")
    }
    let expectedBytes = width * height * 4 * MemoryLayout<Float>.size
    guard inputBytes.count == expectedBytes else {
      throw PipelineError.renderFailed(
        code: 9,
        message:
          "applyChainAndEncodeDisplayTargetWindow: input \(inputBytes.count) bytes != expected \(expectedBytes)"
      )
    }
    var output = Data(count: expectedBytes)
    var window = window
    let rc: Int32 = try withChainPointers(
      params, noiseProfile: noiseProfile, localAdjustments: localAdjustments
    ) { bound in
      var p = bound
      return try curves.withMapleToneCurves { curvesPtr in
        try output.withUnsafeMutableBytes { outBuf -> Int32 in
          let outPtr = outBuf.bindMemory(to: Float.self).baseAddress!
          return inputBytes.withUnsafeBytes { inBuf -> Int32 in
            let inPtr = inBuf.bindMemory(to: Float.self).baseAddress!
            return maple_apply_chain_and_encode_display_target_window_f32(
              inPtr, UInt32(width), UInt32(height), &p, curvesPtr, targetPrimaries, &window,
              outPtr)
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
}
