import Foundation
import RawPipeline

extension PipelineRenderer {
  /// P3-aware sibling of `applyChainAndEncodeDisplay` (#3190), via
  /// `maple_apply_chain_and_encode_display_target_f32`. Identical
  /// contract, plus `targetPrimaries` selecting the ENCODE stage's target
  /// primaries — independent of `params.target_primaries`, which the
  /// caller must keep at `0` (sRGB) so the chain stage never runs its own
  /// inline conversion (see the Rust entry's module doc for why reusing
  /// `params.target_primaries` for both would double-convert).
  public static func applyChainAndEncodeDisplayTarget(
    inputBytes: Data,
    width: Int,
    height: Int,
    params: MapleAdjustmentParams,
    targetPrimaries: UInt32,
    noiseProfile: [Float]? = nil,
    localAdjustments: [LocalAdjustment] = []
  ) throws -> Data {
    try applyChainAndEncodeDisplayTargetWithAuto(
      inputBytes: inputBytes, width: width, height: height, params: params,
      targetPrimaries: targetPrimaries, noiseProfile: noiseProfile,
      localAdjustments: localAdjustments, nativeAutoProfile: nil)
  }

  static func applyChainAndEncodeDisplayTargetWithAuto(
    inputBytes: Data,
    width: Int,
    height: Int,
    params: MapleAdjustmentParams,
    targetPrimaries: UInt32,
    noiseProfile: [Float]? = nil,
    localAdjustments: [LocalAdjustment] = [],
    nativeAutoProfile: NativeAutoProfile?
  ) throws -> Data {
    guard width > 0, height > 0 else {
      throw PipelineError.renderFailed(
        code: 2,
        message: "applyChainAndEncodeDisplayTarget: zero dimension width=\(width) height=\(height)"
      )
    }
    // Same rejection as `encodeDisplay` — do not let an invalid Swift-side
    // caller value fall through to Rust's defensive sRGB coercion
    // (Copilot review on #3239).
    guard
      targetPrimaries == CanvasColorSpace.srgb.wireValue
        || targetPrimaries == CanvasColorSpace.displayP3.wireValue
    else {
      throw PipelineError.renderFailed(
        code: 2,
        message: "applyChainAndEncodeDisplayTarget: unsupported targetPrimaries=\(targetPrimaries)"
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
      return try output.withUnsafeMutableBytes { outBuf -> Int32 in
        let outPtr = outBuf.bindMemory(to: Float.self).baseAddress!
        return inputBytes.withUnsafeBytes { inBuf -> Int32 in
          let inPtr = inBuf.bindMemory(to: Float.self).baseAddress!
          if let artifacts = nativeAutoProfile?.artifacts {
            return artifacts.withBuffers { curve, lut in
              maple_apply_chain_and_encode_native_auto_f32(
                inPtr, UInt32(width), UInt32(height), &p, curve.count > 0 ? curve.baseAddress : nil,
                UInt(curve.count),
                lut.count > 0 ? lut.baseAddress : nil, UInt(artifacts.lutSize), UInt(lut.count),
                outPtr)
            }
          }
          return maple_apply_chain_and_encode_display_target_f32(
            inPtr, UInt32(width), UInt32(height),
            &p,
            targetPrimaries,
            outPtr
          )
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
