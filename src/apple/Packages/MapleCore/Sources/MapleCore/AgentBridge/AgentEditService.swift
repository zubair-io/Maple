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

  private weak var activeSession: EditSession?

  public init() {}

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
    let (merged, applied) = try AgentAdjustmentPatch.apply(patch, to: session.model)
    let label = arguments["description"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    session.beginEdit(kind: .adjustment, description: "AI: \(label ?? "Adjust")")
    session.model = merged
    session.endEdit()
    var result = summaryFields(session)
    result["applied"] = .object(applied.mapValues(JSONValue.number))
    return .object(result)
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

  private func summaryFields(_ session: EditSession) -> [String: JSONValue] {
    [
      "photo_id": .string(session.asset.id.uuidString),
      "revision": .string(Self.revision(of: session)),
      "can_undo": .bool(session.canUndo),
    ]
  }

  private func summary(_ session: EditSession) -> JSONValue { .object(summaryFields(session)) }

  private func describe(_ session: EditSession) -> JSONValue {
    var fields = summaryFields(session)
    fields["file_name"] = .string(session.asset.displayName)
    let size = session.nativeImageSize
    if size.width > 0, size.height > 0 {
      fields["image_size"] = ["width": .int(Int(size.width)), "height": .int(Int(size.height))]
    }
    fields["adjustments"] = AgentAdjustmentPatch.describe(session.model)
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
