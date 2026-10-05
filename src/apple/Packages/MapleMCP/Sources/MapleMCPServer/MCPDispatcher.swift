import Foundation
import MapleAgentWire

/// Answers MCP JSON-RPC messages. Dual-era per the 2026-07-28 spec: modern
/// clients send per-request `_meta` (and may probe with `server/discover`);
/// legacy clients (2025-11-25, 2025-06-18) open with `initialize`. Tool calls
/// are forwarded to the running app; nothing here holds photo state.
public final class MCPDispatcher {
  public typealias Forward = (AgentRequest) throws -> AgentResponse

  public static let modernVersions = ["2026-07-28"]
  public static let legacyVersions = ["2025-11-25", "2025-06-18"]
  public static var supportedVersions: [String] { modernVersions + legacyVersions }
  public static let serverName = "maple"
  public static let serverVersion = "1.0.0"

  static let instructions = """
    Maple is a RAW photo editor. These tools act on the photo the photographer has open, live: \
    they watch the sliders move. Start with maple_get_active_photo, look with \
    maple_render_and_inspect, then change sliders with maple_set_adjustments, passing the \
    latest `revision` each time. Prefer small, explainable moves and re-inspect after each one.
    """

  private let forward: Forward
  private var nextRequestID = 0

  public init(forward: @escaping Forward) {
    self.forward = forward
  }

  /// The response for `message`, or nil when it is a notification.
  public func handle(_ message: JSONValue) -> JSONValue? {
    nextRequestID += 1
    switch Self.route(message, requestID: nextRequestID) {
    case .reply(let reply): return reply
    case .tool(let id, let request):
      do { return Self.toolReply(id: id, response: try forward(request)) } catch {
        return Self.result(id: id, Self.toolError(Self.unreachableMessage(error)))
      }
    }
  }

  /// HTTP runs inside Maple and awaits the editor directly, while the stdio
  /// executable keeps its synchronous socket forwarding. Both share routing
  /// and result serialization, including image content and readable errors.
  public static func handle(
    _ message: JSONValue,
    forwarding forward: @Sendable (AgentRequest) async throws -> AgentResponse
  ) async -> JSONValue? {
    switch route(message, requestID: 1) {
    case .reply(let reply): return reply
    case .tool(let id, let request):
      do { return toolReply(id: id, response: try await forward(request)) } catch {
        return result(id: id, toolError(unreachableMessage(error)))
      }
    }
  }

  private enum Route {
    case reply(JSONValue?)
    case tool(id: JSONValue, request: AgentRequest)
  }

  private static func route(_ message: JSONValue, requestID: Int) -> Route {
    guard case .object(let fields) = message, fields["jsonrpc"] == "2.0",
      let method = fields["method"]?.stringValue
    else {
      return .reply(
        Self.error(id: message["id"] ?? .null, code: -32600, message: "Invalid Request"))
    }
    guard let id = fields["id"], id != .null else { return .reply(nil) }
    let params = fields["params"]?.objectValue ?? [:]
    if let requested = params["_meta"]?["io.modelcontextprotocol/protocolVersion"]?.stringValue,
      !Self.supportedVersions.contains(requested)
    {
      return .reply(
        Self.error(
          id: id, code: -32022, message: "Unsupported protocol version",
          data: [
            "supported": .array(Self.supportedVersions.map(JSONValue.string)),
            "requested": .string(requested),
          ]))
    }
    switch method {
    case "initialize":
      return .reply(Self.result(id: id, initialize(params)))
    case "server/discover":
      return .reply(Self.result(id: id, discover()))
    case "ping":
      return .reply(Self.result(id: id, [:]))
    case "tools/list":
      return .reply(Self.result(id: id, ["tools": .array(MCPToolCatalog.tools)]))
    case "tools/call":
      guard let name = params["name"]?.stringValue else {
        return .reply(error(id: id, code: -32602, message: "tools/call requires `name`"))
      }
      guard MCPToolCatalog.toolNames.contains(name) else {
        return .reply(error(id: id, code: -32602, message: "Unknown tool: \(name)"))
      }
      return .tool(
        id: id,
        request: AgentRequest(
          id: requestID, tool: name, arguments: params["arguments"]?.objectValue ?? [:]))
    default:
      return .reply(Self.error(id: id, code: -32601, message: "Method not found: \(method)"))
    }
  }

  private static func initialize(_ params: [String: JSONValue]) -> JSONValue {
    let requested = params["protocolVersion"]?.stringValue ?? ""
    let version =
      Self.legacyVersions.contains(requested) ? requested : Self.legacyVersions[0]
    return [
      "protocolVersion": .string(version),
      "capabilities": ["tools": [:]],
      "serverInfo": serverInfo,
      "instructions": .string(Self.instructions),
    ]
  }

  private static func discover() -> JSONValue {
    [
      "supportedVersions": .array(Self.supportedVersions.map(JSONValue.string)),
      "capabilities": ["tools": [:]],
      "instructions": .string(Self.instructions),
      "_meta": ["io.modelcontextprotocol/serverInfo": serverInfo],
    ]
  }

  private static var serverInfo: JSONValue {
    ["name": .string(Self.serverName), "version": .string(Self.serverVersion)]
  }

  private static func toolReply(id: JSONValue, response: AgentResponse) -> JSONValue {
    switch response.outcome {
    case .success(let payload):
      var content: [JSONValue] = []
      for image in payload.images {
        content.append([
          "type": "image", "data": .string(image.data.base64EncodedString()),
          "mimeType": .string(image.mimeType),
        ])
      }
      let text = (try? payload.result.encodedLine()).map { String(decoding: $0, as: UTF8.self) }
      content.append(["type": "text", "text": .string(text ?? "{}")])
      return Self.result(
        id: id,
        ["content": .array(content), "structuredContent": payload.result, "isError": false])
    case .failure(let error):
      var message = "\(error.code): \(error.message)"
      if let details = error.details, let encoded = try? details.encodedLine() {
        message += "\n" + String(decoding: encoded, as: UTF8.self)
      }
      return Self.result(id: id, Self.toolError(message))
    }
  }

  static func unreachableMessage(_ error: Error) -> String {
    if case .system(let call, let code) = error as? AgentSocketError, call == "connect",
      code == ENOENT || code == ECONNREFUSED
    {
      return
        "maple_unavailable: Maple isn't running, or AI agent access is off. Ask the photographer to open Maple and turn on Settings → General → AI Agents."
    }
    return "maple_unavailable: Could not reach Maple (\(error))."
  }

  static func toolError(_ text: String) -> JSONValue {
    ["content": [["type": "text", "text": .string(text)]], "isError": true]
  }

  static func result(id: JSONValue, _ result: JSONValue) -> JSONValue {
    var fields = result.objectValue ?? [:]
    fields["resultType"] = "complete"
    return ["jsonrpc": "2.0", "id": id, "result": .object(fields)]
  }

  static func error(id: JSONValue, code: Int, message: String, data: JSONValue? = nil) -> JSONValue
  {
    var error: [String: JSONValue] = ["code": .int(code), "message": .string(message)]
    if let data { error["data"] = data }
    return ["jsonrpc": "2.0", "id": id, "error": .object(error)]
  }
}
