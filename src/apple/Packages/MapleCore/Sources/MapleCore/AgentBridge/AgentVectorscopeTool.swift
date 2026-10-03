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
    let region = try AgentInspector.Region.parse(arguments["region"])

    if let value = arguments["mask_id"], value.stringValue == nil {
      throw AgentError(code: "invalid_arguments", message: "mask_id must be a UUID string.")
    }
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

    let hasSkinTarget =
      targetLayer?.range == .skinTone || targetLayer?.kindName == "person_skin"
      || targetLayer?.kindName == "whole_image_skin"
    let maskId = targetLayer?.id.uuidString

    let pixels = try await session.agentScopePixels(maskID: targetLayer?.id, region: region)
    let evidence = try AgentVectorscope.reduce(
      rgba: pixels.rgba, width: pixels.width,
      height: pixels.height, weighted: pixels.weighted)
    let result = AgentVectorscope.result(evidence, hasSkinTarget: hasSkinTarget, maskId: maskId)

    var dict = AgentEditService.summaryFields(session)
    for (k, v) in result.json.objectValue ?? [:] {
      dict[k] = v
    }

    return AgentPayload(result: .object(dict))
  }
}
