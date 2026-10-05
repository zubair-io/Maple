import CryptoKit
import Foundation
import MapleAgentWire

/// Routes agent tool calls to the photo open in the editor. Every mutation
/// goes through the same `beginEdit` / `model` / `endEdit` transaction the
/// sliders use, so the canvas redraws, the sidecar persists through the
/// app's normal store, and each call is exactly one undo entry.
///
/// Mutations require the `revision` the agent last observed. It covers the
/// photo identity and the full adjustment state, so a photo switch, a
/// manual slider move or an undo between the agent's look and its edit is
/// refused instead of being applied to state the agent never saw.
@MainActor
public final class AgentEditService {
  public static let shared = AgentEditService()

  public weak var browseDelegate: (any AgentBrowseDelegate)?
  private weak var activeSession: EditSession?
  private let exportDirectory: URL?

  public init(exportDirectory: URL? = nil) {
    self.exportDirectory = exportDirectory
  }

  public func activate(_ session: EditSession) {
    activeSession = session
  }

  public func deactivate(_ session: EditSession) {
    if activeSession === session { activeSession = nil }
  }

  public func handle(_ request: AgentRequest) async -> AgentResponse {
    do {
      let payload = try await perform(request.tool, request.arguments)
      return AgentResponse(id: request.id, outcome: .success(payload))
    } catch let error as AgentError {
      return AgentResponse(id: request.id, outcome: .failure(error))
    } catch {
      return AgentResponse(
        id: request.id,
        outcome: .failure(AgentError(code: "internal", message: error.localizedDescription)))
    }
  }

  private func perform(_ tool: String, _ arguments: [String: JSONValue]) async throws
    -> AgentPayload
  {
    switch tool {
    case "maple_get_active_photo":
      return AgentPayload(result: describe(try session()))
    case "maple_set_adjustments":
      return AgentPayload(result: try setAdjustments(arguments))
    case "maple_render_and_inspect":
      return try await renderAndInspect(arguments)
    case "maple_export_photo":
      guard Set(arguments.keys) == ["expected_revision"] else {
        throw AgentError(
          code: "invalid_arguments", message: "Export accepts only `expected_revision`.")
      }
      let session = try editableSession(arguments)
      let revision = Self.revision(of: session)
      return try await AgentPhotoExporter.export(
        session: session, revision: revision, directory: exportDirectory
      ) {
        guard self.activeSession === session, Self.revision(of: session) == revision else {
          throw AgentError(
            code: "stale_revision",
            message: "The photo changed during export. No file was saved; re-read its state.")
        }
      }
    case "maple_create_mask":
      let session = try editableSession(arguments)
      return AgentPayload(
        result: try await AgentMaskService.createMask(arguments, in: session) {
          guard try self.editableSession(arguments) === session else {
            throw AgentError(
              code: "stale_revision",
              message: "The active edit session changed. Nothing was applied.")
          }
        })
    case "maple_render_mask_overlay":
      let session = try session()
      let revision = Self.revision(of: session)
      let payload = try await AgentMaskService.renderMaskOverlay(arguments, in: session)
      try validateInspection(session, revision: revision)
      return payload
    case "maple_get_vectorscope":
      let session = try session()
      let revision = Self.revision(of: session)
      let payload = try await AgentVectorscopeTool.getVectorscope(arguments, in: session)
      try validateInspection(session, revision: revision)
      return payload
    case "maple_list_photos":
      return AgentPayload(
        result: try await AgentBrowseService.listPhotos(
          arguments, delegate: browseDelegate, activeSession: activeSession))
    case "maple_get_thumbnails":
      return try await AgentBrowseService.getThumbnails(
        arguments, delegate: browseDelegate, activeSession: activeSession)
    case "maple_set_rating":
      return AgentPayload(
        result: try await AgentBrowseService.setRating(
          arguments, delegate: browseDelegate, activeSession: activeSession))
    case "maple_set_flag":
      return AgentPayload(
        result: try await AgentBrowseService.setFlag(
          arguments, delegate: browseDelegate, activeSession: activeSession))
    case "maple_open_photo":
      let newSession = try await AgentBrowseService.openPhoto(arguments, delegate: browseDelegate)
      activate(newSession)
      return AgentPayload(result: describe(newSession))
    case "maple_undo":
      let session = try editableSession(arguments)
      guard session.canUndo else {
        throw AgentError(code: "nothing_to_undo", message: "There is no edit to undo.")
      }
      session.undo()
      return AgentPayload(result: summary(session))
    case "maple_reset":
      let session = try editableSession(arguments)
      session.resetToOriginal()
      return AgentPayload(result: summary(session))
    default:
      throw AgentError(code: "unknown_tool", message: "Maple has no tool named `\(tool)`.")
    }
  }

  private func setAdjustments(_ arguments: [String: JSONValue]) throws -> JSONValue {
    guard let patch = arguments["adjustments"]?.objectValue else {
      throw AgentError(
        code: "invalid_arguments", message: "`adjustments` must be an object of slider → number.")
    }
    let session = try editableSession(arguments)
    let label = arguments["description"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }

    if let value = arguments["mask_id"], value.stringValue == nil {
      throw AgentError(code: "invalid_arguments", message: "mask_id must be a UUID string.")
    }
    if let maskIdStr = arguments["mask_id"]?.stringValue {
      guard let maskId = UUID(uuidString: maskIdStr) else {
        throw AgentError(code: "invalid_arguments", message: "`mask_id` must be a valid UUID.")
      }
      guard let layerIndex = session.model.localAdjustments.firstIndex(where: { $0.id == maskId })
      else {
        throw AgentError(code: "mask_not_found", message: "No mask found with ID `\(maskIdStr)`.")
      }
      let currentLayer = session.model.localAdjustments[layerIndex]
      let (updatedAdjustments, applied) = try AgentAdjustmentPatch.applyLocal(
        patch, to: currentLayer.adjustments)
      session.beginEdit(kind: .adjustment, description: "AI: \(label ?? "Adjust mask")")
      session.model.localAdjustments[layerIndex].adjustments = updatedAdjustments
      session.endEdit()
      var result = Self.summaryFields(session)
      result["mask_id"] = .string(maskIdStr)
      result["applied"] = .object(applied.mapValues(JSONValue.number))
      return .object(result)
    }

    let (merged, applied) = try AgentAdjustmentPatch.apply(patch, to: session.model)
    session.beginEdit(kind: .adjustment, description: "AI: \(label ?? "Adjust")")
    session.model = merged
    session.endEdit()
    var result = Self.summaryFields(session)
    result["applied"] = .object(applied.mapValues(JSONValue.number))
    return .object(result)
  }

  /// The image, metrics and revision all describe one render: the
  /// snapshot is taken after pending renders drain, and discarded if the
  /// state moved while it was produced.
  private func renderAndInspect(_ arguments: [String: JSONValue]) async throws -> AgentPayload {
    let maxEdge = try AgentInspector.parseMaxEdge(arguments["max_edge"])
    let region = try AgentInspector.Region.parse(arguments["region"])
    let session = try session()
    let revision = Self.revision(of: session)
    guard let image = await session.agentCanvasSnapshot() else {
      throw AgentError(
        code: "render_unavailable",
        message: "Maple hasn't finished rendering this photo yet. Retry in a moment.")
    }
    guard activeSession === session, Self.revision(of: session) == revision else {
      throw AgentError(
        code: "render_superseded",
        message: "The photo changed while it was rendering. Call maple_render_and_inspect again.")
    }
    let context = session.pipeline.context
    let inspection = try await Task.detached(priority: .userInitiated) {
      try AgentInspector.inspect(image, maxEdge: maxEdge, region: region, context: context)
    }.value
    // JPEG encoding and metrics run off the main actor. Revalidate after
    // that suspension before assembling any state fields with these pixels.
    guard activeSession === session, Self.revision(of: session) == revision else {
      throw AgentError(
        code: "render_superseded",
        message: "The photo changed during inspection. Call maple_render_and_inspect again.")
    }
    var result = Self.summaryFields(session)
    result["revision"] = .string(revision)
    result["width"] = .int(inspection.width)
    result["height"] = .int(inspection.height)
    result["metrics"] = inspection.metrics
    return AgentPayload(
      result: .object(result), image: AgentImage(data: inspection.jpeg, mimeType: "image/jpeg"))
  }

  private func validateInspection(_ session: EditSession, revision: String) throws {
    guard activeSession === session, Self.revision(of: session) == revision else {
      throw AgentError(
        code: "render_superseded",
        message: "The photo changed during inspection. Call the tool again.")
    }
  }

  private func session() throws -> EditSession {
    guard let activeSession else {
      throw AgentError(
        code: "no_active_photo",
        message: "No photo is open in Maple's editor. Ask the photographer to open one.")
    }
    return activeSession
  }

  private func editableSession(_ arguments: [String: JSONValue]) throws -> EditSession {
    let session = try session()
    guard let expected = arguments["expected_revision"]?.stringValue else {
      throw AgentError(
        code: "invalid_arguments",
        message: "`expected_revision` is required. Call maple_get_active_photo first.")
    }
    let current = Self.revision(of: session)
    guard expected == current else {
      throw AgentError(
        code: "stale_revision",
        message:
          "The photo changed since revision \(expected) (a different photo, a manual edit, or an undo). Nothing was applied. Re-read the current state below and decide again.",
        details: describe(session))
    }
    guard !session.workflow.isBusy else {
      throw AgentError(
        code: "busy", message: "Maple is busy with another operation on this photo. Retry shortly.")
    }
    return session
  }

  public static func summaryFields(_ session: EditSession) -> [String: JSONValue] {
    [
      "photo_id": .string(session.asset.id.uuidString),
      "revision": .string(Self.revision(of: session)),
      "can_undo": .bool(session.canUndo),
    ]
  }

  private func summary(_ session: EditSession) -> JSONValue { .object(Self.summaryFields(session)) }

  private func describe(_ session: EditSession) -> JSONValue {
    var fields = Self.summaryFields(session)
    fields["file_name"] = .string(session.asset.displayName)
    let size = session.nativeImageSize
    if size.width > 0, size.height > 0 {
      fields["image_size"] = ["width": .int(Int(size.width)), "height": .int(Int(size.height))]
    }
    fields["adjustments"] = AgentAdjustmentPatch.describe(session.model)

    if !session.model.localAdjustments.isEmpty {
      fields["masks"] = .array(
        session.model.localAdjustments.map { layer in
          var m: [String: JSONValue] = [
            "id": .string(layer.id.uuidString),
            "kind": .string(layer.kindName),
            "is_selected": .bool(session.selectedMaskId == layer.id),
            "enabled": .bool(session.isMaskEnabled(id: layer.id)),
          ]
          if layer.range == .skinTone {
            m["is_skin_tone"] = .bool(true)
          }
          return .object(m)
        })
    }
    if let selected = session.selectedMaskId {
      fields["selected_mask_id"] = .string(selected.uuidString)
    }

    fields["vectorscope"] = [
      "target_hint_deg": .number(AgentVectorscope.skinToneLineAngleDeg),
      "target_wedge_deg": .number(AgentVectorscope.skinToneLineWedgeDeg),
      "has_skin_target": .bool(
        session.selectedMaskLayer?.range == .skinTone
          || session.selectedMaskLayer?.kindName == "person_skin"
          || session.selectedMaskLayer?.kindName == "whole_image_skin"),
    ]

    fields["rating"] = .int(session.culling.stars)
    fields["flag"] = .string(session.culling.flag.rawValue)
    if let color = session.culling.colorLabel {
      fields["color_label"] = .string(color.rawValue)
    }

    return .object(fields)
  }

  static func revision(of session: EditSession) -> String {
    revision(assetID: session.asset.id, model: session.model)
  }

  nonisolated static func revision(assetID: UUID, model: AdjustmentModel) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    var digest = SHA256()
    digest.update(data: Data(assetID.uuidString.utf8))
    digest.update(data: (try? encoder.encode(model)) ?? Data())
    return digest.finalize().prefix(8).map { String(format: "%02x", $0) }.joined()
  }
}
