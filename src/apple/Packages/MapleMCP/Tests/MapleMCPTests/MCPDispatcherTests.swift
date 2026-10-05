import Foundation
import XCTest

@testable import MapleAgentWire
@testable import MapleMCPServer

final class MCPDispatcherTests: XCTestCase {
  private func request(_ method: String, id: Int = 1, params: JSONValue = [:]) -> JSONValue {
    ["jsonrpc": "2.0", "id": .int(id), "method": .string(method), "params": params]
  }

  private func reply(
    _ message: JSONValue,
    forwarding forward: MCPDispatcher.Forward = { _ in throw CocoaError(.userCancelled) }
  ) async throws -> JSONValue {
    let response = await MCPDispatcher.handle(message, forwarding: forward)
    return try XCTUnwrap(response)
  }

  func testLegacyInitializeEchoesASupportedVersion() async throws {
    let reply = try await reply(
      request("initialize", params: ["protocolVersion": "2025-06-18", "capabilities": [:]]))
    XCTAssertEqual(reply["result"]?["protocolVersion"], "2025-06-18")
    XCTAssertEqual(reply["result"]?["serverInfo"]?["name"], "maple")
    XCTAssertNotNil(reply["result"]?["capabilities"]?["tools"])
  }

  func testLegacyInitializeWithUnknownVersionOffersTheNewestLegacyVersion() async throws {
    let reply = try await reply(
      request("initialize", params: ["protocolVersion": "2024-11-05"]))
    XCTAssertEqual(reply["result"]?["protocolVersion"], "2025-11-25")
  }

  func testModernDiscoverAndUnsupportedVersionError() async throws {
    let meta: JSONValue = ["_meta": ["io.modelcontextprotocol/protocolVersion": "2026-07-28"]]
    let discover = try await reply(request("server/discover", params: meta))
    XCTAssertEqual(discover["result"]?["resultType"], "complete")
    XCTAssertEqual(
      discover["result"]?["supportedVersions"], ["2026-07-28", "2025-11-25", "2025-06-18"])

    let bad: JSONValue = ["_meta": ["io.modelcontextprotocol/protocolVersion": "1900-01-01"]]
    let error = try await reply(request("tools/list", params: bad))
    XCTAssertEqual(error["error"]?["code"], -32022)
    XCTAssertEqual(error["error"]?["data"]?["requested"], "1900-01-01")
  }

  func testNotificationsGetNoReplyAndUnknownMethodsAreJSONRPCErrors() async throws {
    let notification = await MCPDispatcher.handle(
      ["jsonrpc": "2.0", "method": "notifications/initialized"],
      forwarding: { _ in throw CocoaError(.userCancelled) })
    XCTAssertNil(notification)
    let unknown = try await reply(request("bogus"))
    let invalid = try await reply(["id": 1, "method": "ping"])
    XCTAssertEqual(unknown["error"]?["code"], -32601)
    XCTAssertEqual(invalid["error"]?["code"], -32600)
  }

  func testToolListHasSchemasAndAnnotations() async throws {
    let reply = try await reply(request("tools/list"))
    guard case .array(let tools) = reply["result"]?["tools"] else { return XCTFail("no tools") }
    XCTAssertEqual(
      Set(tools.compactMap { $0["name"]?.stringValue }),
      [
        "maple_get_active_photo", "maple_set_adjustments", "maple_render_and_inspect",
        "maple_create_mask", "maple_render_mask_overlay", "maple_get_vectorscope",
        "maple_undo", "maple_reset",
        "maple_list_photos", "maple_get_thumbnails", "maple_set_rating",
        "maple_set_flag", "maple_open_photo", "maple_export_photo",
      ])
    for tool in tools {
      XCTAssertEqual(tool["inputSchema"]?["type"], "object", "\(tool)")
      XCTAssertEqual(tool["outputSchema"]?["type"], "object", "\(tool)")
      XCTAssertNotNil(tool["annotations"]?["readOnlyHint"], "\(tool)")
    }
    let reset = tools.first { $0["name"] == "maple_reset" }
    XCTAssertEqual(reset?["annotations"]?["destructiveHint"], true)
  }

  func testSuccessfulCallReturnsStructuredContentTextAndImage() async throws {
    let forward: MCPDispatcher.Forward = { request in
      XCTAssertEqual(request.tool, "maple_render_and_inspect")
      XCTAssertEqual(request.arguments["max_edge"], 512)
      return AgentResponse(
        id: request.id,
        outcome: .success(
          AgentPayload(
            result: ["revision": "r2"],
            image: AgentImage(data: Data([1, 2]), mimeType: "image/jpeg"))))
    }
    let reply = try await reply(
      request(
        "tools/call",
        params: ["name": "maple_render_and_inspect", "arguments": ["max_edge": 512]]),
      forwarding: forward)

    let result = try XCTUnwrap(reply["result"])
    XCTAssertEqual(result["isError"], false)
    XCTAssertEqual(result["structuredContent"], ["revision": "r2"])
    XCTAssertEqual(
      result["content"],
      [
        [
          "type": "image", "data": .string(Data([1, 2]).base64EncodedString()),
          "mimeType": "image/jpeg",
        ],
        ["type": "text", "text": #"{"revision":"r2"}"#],
      ])
  }

  func testSuccessfulCallReturnsMultipleImages() async throws {
    let forward: MCPDispatcher.Forward = { request in
      AgentResponse(
        id: request.id,
        outcome: .success(
          AgentPayload(
            result: ["count": 2],
            images: [
              AgentImage(data: Data([1]), mimeType: "image/jpeg"),
              AgentImage(data: Data([2]), mimeType: "image/jpeg"),
            ])))
    }
    let reply = try await reply(
      request(
        "tools/call",
        params: ["name": "maple_get_thumbnails", "arguments": [:]]), forwarding: forward)
    let result = try XCTUnwrap(reply["result"])
    XCTAssertEqual(result["isError"], false)
    XCTAssertEqual(
      result["content"],
      [
        [
          "type": "image", "data": .string(Data([1]).base64EncodedString()),
          "mimeType": "image/jpeg",
        ],
        [
          "type": "image", "data": .string(Data([2]).base64EncodedString()),
          "mimeType": "image/jpeg",
        ],
        ["type": "text", "text": #"{"count":2}"#],
      ])
  }

  func testAppErrorsBecomeReadableToolErrorsNotProtocolErrors() async throws {
    let forward: MCPDispatcher.Forward = { request in
      AgentResponse(
        id: request.id,
        outcome: .failure(
          AgentError(code: "invalid_arguments", message: "`exposure` = 9.0 is outside -4.0…4.0")))
    }
    let reply = try await reply(
      request("tools/call", params: ["name": "maple_set_adjustments", "arguments": [:]]),
      forwarding: forward)
    XCTAssertNil(reply["error"])
    XCTAssertEqual(reply["result"]?["isError"], true)
    XCTAssertEqual(
      reply["result"]?["content"],
      [["type": "text", "text": "invalid_arguments: `exposure` = 9.0 is outside -4.0…4.0"]])
  }

  func testForwardingFailureIsAClearToolErrorWithNoFallback() async throws {
    let reply = try await reply(
      request("tools/call", params: ["name": "maple_get_active_photo"]))
    XCTAssertEqual(reply["result"]?["isError"], true)
    let text = reply["result"]?["content"].flatMap { content -> String? in
      guard case .array(let items) = content else { return nil }
      return items.first?["text"]?.stringValue
    }
    XCTAssertTrue(text?.hasPrefix("maple_unavailable: Could not reach Maple") ?? false, text ?? "")
  }

  func testUnknownToolIsAnInvalidParamsError() async throws {
    let reply = try await reply(request("tools/call", params: ["name": "rm_rf"]))
    XCTAssertEqual(reply["error"]?["code"], -32602)
  }
}
