import CoreImage
import Foundation
import MapleAgentWire

@MainActor
extension EditSession {
  /// Snapshot one settled render's pixels and canonical selected-layer coverage.
  /// Scope requests are explicit off-tick work; no HUD/present behavior changes.
  func agentScopePixels(maskID: UUID?, region: AgentInspector.Region?) async throws
    -> AgentScopePixels
  {
    _ = await latestRenderSchedule?.value
    await renderActor.awaitCurrentRenderIfInFlight()
    let model = renderModel
    let layer: Int32
    if let maskID {
      guard let index = model.localAdjustments.firstIndex(where: { $0.id == maskID }) else {
        throw AgentError(
          code: "mask_not_found", message: "The selected mask is not active in this render.")
      }
      layer = Int32(index)
    } else {
      layer = -1
    }
    let anchor = wbDeltaAnchor
    let frame = wbSliderFrame
    let resolvedIsRaw = await renderActor.resolvedIsRaw(for: asset.id) ?? asset.isRaw
    if gpuFramePresented, !gpuPresentFailed, let driver = gpuLiveDriver {
      return try await driver.agentScopePixels(
        model: model,
        asShotCCT: resolvedIsRaw ? (anchor?.temperature ?? asShotCCT) : 6500,
        asShotTint: resolvedIsRaw ? (anchor?.tint ?? asShotTint) : 0,
        wbFrame: resolvedIsRaw ? frame : nil, layer: layer, region: region)
    }
    let cpuFrame = try await agentCPUFrame(maskID: maskID)
    let context = pipeline.context
    return try await Task.detached(priority: .userInitiated) {
      try AgentVectorscope.capturePixels(
        canvas: cpuFrame.canvas, weights: cpuFrame.weights, region: region, context: context)
    }.value
  }
}
