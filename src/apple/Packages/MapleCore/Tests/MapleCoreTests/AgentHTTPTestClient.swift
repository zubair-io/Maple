#if os(macOS)
  import Foundation
  import MapleAgentWire
  import MapleMCPHTTP
  import XCTest

  @testable import MapleCore

  /// Real authenticated HTTP, with a fresh listener per service test.
  struct AgentHTTPTestClient: Sendable {
    let url: URL
    let token: String

    @MainActor
    static func withService(
      _ service: AgentEditService, body: (Self) async throws -> Void
    ) async throws {
      let server = MCPHTTPServer { await service.handle($0) }
      let token = UUID().uuidString
      let url = try await server.start(port: 0, token: token)
      do {
        try await body(Self(url: url, token: token))
        await server.stop()
      } catch {
        await server.stop()
        throw error
      }
    }

    func send(_ request: AgentRequest) async throws -> AgentResponse {
      var http = URLRequest(url: url)
      http.httpMethod = "POST"
      http.timeoutInterval = 30
      http.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      http.setValue("application/json", forHTTPHeaderField: "Content-Type")
      http.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
      http.setValue("2025-11-25", forHTTPHeaderField: "MCP-Protocol-Version")
      let message: JSONValue = [
        "jsonrpc": "2.0", "id": .int(request.id), "method": "tools/call",
        "params": ["name": .string(request.tool), "arguments": .object(request.arguments)],
      ]
      http.httpBody = try message.encodedLine()
      let (data, response) = try await URLSession.shared.data(for: http)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      let json = try JSONValue.decode(data)
      XCTAssertEqual(json["id"], .int(request.id))
      let payload = try XCTUnwrap(json["result"])
      if payload["isError"] == true {
        let text = try XCTUnwrap(payload["content"]?.arrayValue?.first?["text"]?.stringValue)
        let parts = text.split(separator: ":", maxSplits: 1).map(String.init)
        return AgentResponse(
          id: request.id,
          outcome: .failure(AgentError(code: parts[0], message: parts.last ?? text)))
      }
      let images = try (payload["content"]?.arrayValue ?? []).compactMap { item -> AgentImage? in
        guard item["type"] == "image" else { return nil }
        let encoded = try XCTUnwrap(item["data"]?.stringValue)
        return AgentImage(
          data: try XCTUnwrap(Data(base64Encoded: encoded)),
          mimeType: try XCTUnwrap(item["mimeType"]?.stringValue))
      }
      return AgentResponse(
        id: request.id,
        outcome: .success(
          AgentPayload(result: try XCTUnwrap(payload["structuredContent"]), images: images)))
    }
  }
#endif
