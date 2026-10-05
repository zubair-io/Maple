import Foundation
import MapleAgentWire
import MapleMCPServer
import NIOHTTP1

struct MCPHTTPResponse {
  let status: HTTPResponseStatus
  let body: Data

  init(status: HTTPResponseStatus, json: JSONValue? = nil) {
    self.status = status
    body = (try? json?.encodedLine()) ?? Data()
  }

  static let badRequest = MCPHTTPResponse(status: .badRequest)
}

enum MCPHTTPProtocol {
  static func validateEndpoint(_ head: HTTPRequestHead, port: Int, token: String)
    -> MCPHTTPResponse?
  {
    let hosts = ["127.0.0.1:\(port)", "localhost:\(port)"]
    guard head.headers["Host"].count == 1,
      let host = head.headers.first(name: "Host"), hosts.contains(host.lowercased())
    else { return .init(status: .forbidden) }
    let origins = head.headers["Origin"]
    guard
      origins.isEmpty || (origins.count == 1 && hosts.map { "http://\($0)" }.contains(origins[0]))
    else { return .init(status: .forbidden) }
    let authorization = head.headers["Authorization"]
    guard authorization.count == 1, matches(authorization[0], "Bearer \(token)") else {
      return .init(status: .unauthorized)
    }
    guard head.uri == "/mcp" else { return .init(status: .notFound) }
    guard head.method == .POST else { return .init(status: .methodNotAllowed) }
    let contentTypes = head.headers["Content-Type"]
    guard contentTypes.count == 1,
      contentTypes[0].split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased()
        == "application/json"
    else { return .init(status: .unsupportedMediaType) }
    let accepted = head.headers["Accept"].flatMap { $0.split(separator: ",") }
      .map { $0.split(separator: ";")[0].trimmingCharacters(in: .whitespaces).lowercased() }
    guard accepted.contains("application/json"), accepted.contains("text/event-stream") else {
      return .init(status: .notAcceptable)
    }
    if let length = head.headers.first(name: "Content-Length"),
      let bytes = Int(length), bytes > MCPHTTPChannelHandler.maxBodyBytes
    {
      return .init(status: .payloadTooLarge)
    }
    return nil
  }

  static func reply(head: HTTPRequestHead, body: Data, forward: @escaping MCPHTTPServer.Forward)
    async -> MCPHTTPResponse
  {
    guard let message = try? JSONValue.decode(body) else {
      return failure(.badRequest, code: -32700, message: "Parse error")
    }
    guard message["jsonrpc"] == "2.0", let method = message["method"]?.stringValue,
      !method.isEmpty, message.objectValue != nil,
      message["params"] == nil || message["params"]?.objectValue != nil,
      message["id"] == nil || message["id"]?.stringValue != nil || message["id"]?.numberValue != nil
    else { return failure(.badRequest, code: -32600, message: "Invalid Request") }
    if let error = validateMetadata(head, message: message, method: method) { return error }
    guard let reply = await MCPDispatcher.handle(message, forwarding: forward) else {
      return .init(status: .accepted)
    }
    let modern =
      message["params"]?["_meta"]?["io.modelcontextprotocol/protocolVersion"] == "2026-07-28"
    let unknownMethod = reply["error"]?["code"] == -32601
    return .init(status: modern && unknownMethod ? .notFound : .ok, json: reply)
  }

  private static func validateMetadata(_ head: HTTPRequestHead, message: JSONValue, method: String)
    -> MCPHTTPResponse?
  {
    let id = message["id"] ?? .null
    let versions = head.headers["MCP-Protocol-Version"]
    let version = versions.first
    if versions.count > 1 { return mismatch(id) }
    if let version, !MCPDispatcher.supportedVersions.contains(version) {
      return failure(
        .badRequest, id: id, code: -32022, message: "Unsupported protocol version",
        data: [
          "supported": .array(MCPDispatcher.supportedVersions.map(JSONValue.string)),
          "requested": .string(version),
        ])
    }
    let bodyVersion = message["params"]?["_meta"]?["io.modelcontextprotocol/protocolVersion"]?
      .stringValue
    if version == "2026-07-28" || bodyVersion != nil {
      guard version == bodyVersion,
        head.headers["Mcp-Method"].count == 1,
        head.headers.first(name: "Mcp-Method") == method
      else { return mismatch(id) }
      if method == "tools/call" || method == "resources/read" || method == "prompts/get" {
        let name = message["params"]?[method == "resources/read" ? "uri" : "name"]?.stringValue
        guard head.headers["Mcp-Name"].count == 1,
          let encoded = head.headers.first(name: "Mcp-Name"), decodedHeader(encoded) == name,
          name != nil
        else { return mismatch(id) }
      }
    } else if version == nil && method != "initialize" && message["id"] != nil {
      return mismatch(id)
    }
    return nil
  }

  private static func decodedHeader(_ value: String) -> String? {
    if value.hasPrefix("=?base64?"), value.hasSuffix("?=") {
      return Data(base64Encoded: String(value.dropFirst(9).dropLast(2)))
        .flatMap { String(data: $0, encoding: .utf8) }
    }
    return value
  }

  private static func mismatch(_ id: JSONValue) -> MCPHTTPResponse {
    failure(
      .badRequest, id: id, code: -32020, message: "Missing or mismatched MCP metadata headers")
  }

  private static func failure(
    _ status: HTTPResponseStatus, id: JSONValue = .null, code: Int, message: String,
    data: JSONValue? = nil
  ) -> MCPHTTPResponse {
    var error: [String: JSONValue] = ["code": .int(code), "message": .string(message)]
    if let data { error["data"] = data }
    return .init(status: status, json: ["jsonrpc": "2.0", "id": id, "error": .object(error)])
  }

  private static func matches(_ lhs: String, _ rhs: String) -> Bool {
    let a = Array(lhs.utf8)
    let b = Array(rhs.utf8)
    guard a.count == b.count else { return false }
    return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
  }
}
