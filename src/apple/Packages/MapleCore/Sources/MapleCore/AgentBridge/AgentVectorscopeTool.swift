import CoreGraphics
import CoreImage
import Foundation
import MapleAgentWire

@MainActor
public enum AgentVectorscopeTool {
  public static func getVectorscope(
    _ arguments: [String: JSONValue],
    in session: EditSession
  ) async throws -> AgentPayload {
    guard let canvasCiImage = await session.agentCanvasSnapshot() else {
      throw AgentError(
        code: "render_unavailable",
        message: "Maple hasn't finished rendering this photo yet. Retry in a moment."
      )
    }

    let region = try AgentInspector.Region.parse(arguments["region"])

    let targetLayer: LocalAdjustment?
    if let maskIdStr = arguments["mask_id"]?.stringValue {
      guard let uuid = UUID(uuidString: maskIdStr),
        let layer = session.model.localAdjustments.first(where: { $0.id == uuid })
      else {
        throw AgentError(code: "mask_not_found", message: "No mask found with ID `\(maskIdStr)`.")
      }
      targetLayer = layer
    } else {
      targetLayer = session.selectedMaskLayer
    }

    let maskCoverage: CGImage?
    if let targetLayer {
      maskCoverage = await session.maskCoveragePreview(for: targetLayer.mask)
    } else {
      maskCoverage = nil
    }

    let context = session.pipeline.context
    let hasSkinTarget =
      targetLayer?.range == .skinTone || targetLayer?.kindName == "person_skin"
      || targetLayer?.kindName == "whole_image_skin"
    let maskId = targetLayer?.id.uuidString

    let result = try await Task.detached(priority: .userInitiated) {
      try AgentVectorscope.evaluate(
        canvasCiImage: canvasCiImage,
        maskCoverageCgImage: maskCoverage,
        region: region,
        hasSkinTarget: hasSkinTarget,
        maskId: maskId,
        context: context
      )
    }.value

    var dict = AgentEditService.summaryFields(session)
    for (k, v) in result.json.objectValue ?? [:] {
      dict[k] = v
    }

    return AgentPayload(result: .object(dict))
  }
}
