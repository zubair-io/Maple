import Foundation

extension GpuLiveDriver {
  func agentScopePixels(
    model: AdjustmentModel, asShotCCT: Double?, asShotTint: Double?,
    wbFrame: WbSliderFrame?, layer: Int32, region: AgentInspector.Region?
  ) async throws -> AgentScopePixels {
    guard let session else { throw GpuLiveError(message: "Scope session is unavailable.") }
    let revision = sessionRevision
    let result = try await session.agentScopePixels(
      model: model, asShotCCT: asShotCCT,
      asShotTint: asShotTint, inputShape: inputShape, wbFrame: wbFrame, layer: layer, region: region
    )
    try Task.checkCancellation()
    guard revision == sessionRevision else { throw CancellationError() }
    return result
  }
}
