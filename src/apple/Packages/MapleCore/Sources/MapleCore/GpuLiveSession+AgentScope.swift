import Foundation
import RawPipeline

extension GpuLiveSession {
  /// One synchronous captured chain, never a previous-tick HUD sample.
  func agentScopePixels(
    model: AdjustmentModel, asShotCCT: Double?, asShotTint: Double?, inputShape: UInt32,
    wbFrame: WbSliderFrame?, layer: Int32, region: AgentInspector.Region?
  ) throws -> AgentScopePixels {
    guard let handle else { throw GpuLiveError(message: "Scope session is closed.") }
    let params = PipelineRenderer.makeGpuLiveParams(
      from: model, asShotCCT: asShotCCT,
      asShotTint: asShotTint, inputShape: inputShape, wbFrame: wbFrame,
      whitesAnchorEv: whitesAnchorEv, nrSamplingScale: nrSamplingScale,
      targetColorSpace: .srgb, scopeEnabled: true, scopeLayer: layer)
    let rect = AgentScopePixels.bufferRegion(region, width: width, height: height)
    var output = [UInt8](repeating: 0, count: ScopeSnapshot.maxDim * ScopeSnapshot.maxDim * 4)
    var outWidth: UInt32 = 0
    var outHeight: UInt32 = 0
    let rc = withGpuLiveParams(params, curves: model) { bound in
      withUnsafePointer(to: handle) { pointer in
        output.withUnsafeMutableBufferPointer { buffer in
          maple_gpu_live_scope_snapshot(
            pointer, bound,
            UInt32(rect.minX), UInt32(rect.minY), UInt32(rect.width), UInt32(rect.height),
            buffer.baseAddress, UInt(buffer.count), &outWidth, &outHeight)
        }
      }
    }
    guard rc == 0 else { throw GpuLiveError(message: Self.lastError() ?? "Scope capture failed.") }
    return AgentScopePixels(
      rgba: Array(output.prefix(Int(outWidth * outHeight * 4))),
      width: Int(outWidth), height: Int(outHeight), weighted: layer >= 0)
  }
}
