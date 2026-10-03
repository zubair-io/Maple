import CoreImage
import Foundation
import RawPipeline

extension PipelineRenderer {
  /// Canonical layer coverage at the scene-linear layer input, before the
  /// display/Auto/film tail. RGB is retained for pixel-output qualification.
  static func agentScopeFrame(
    pixels: [Float], width: Int, height: Int, params: MapleAdjustmentParams,
    layer: Int32, noiseProfile: [Float]?, localAdjustments: [LocalAdjustment]
  ) throws -> [Float] {
    guard width > 0, height > 0, width <= 4096, height <= 4096,
      pixels.count == width * height * 4
    else {
      throw PipelineError.renderFailed(code: -1, message: "Invalid scope scene buffer.")
    }
    var output = [Float](repeating: 0, count: pixels.count)
    let rc = try withChainPointers(
      params, noiseProfile: noiseProfile,
      localAdjustments: localAdjustments
    ) { bound in
      var bound = bound
      return pixels.withUnsafeBufferPointer { input in
        output.withUnsafeMutableBufferPointer { result in
          maple_apply_chain_scope_rgba_f32(
            input.baseAddress, UInt(input.count),
            UInt32(width), UInt32(height), &bound, layer, result.baseAddress)
        }
      }
    }
    guard rc == 0 else {
      throw PipelineError.renderFailed(
        code: Int(rc),
        message:
          maple_last_error().map { String(cString: $0) } ?? "Canonical scope coverage failed.")
    }
    return output
  }
}
