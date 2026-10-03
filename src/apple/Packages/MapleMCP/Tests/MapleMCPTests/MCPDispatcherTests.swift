import Foundation
import XCTest

@testable import MapleAgentWire
@testable import MapleMCPServer

final class MCPDispatcherTests: XCTestCase {
  private func request(_ method: String, id: Int = 1, params: JSONValue = [:]) -> JSONValue {
    ["jsonrpc": "2.0", "id": .int(id), "method": .string(method), "params": params]
  }

  private func dispatcher(_ forward: @escaping MCPDispatcher.Forward) -> MCPDispatcher {
    MCPDispatcher(forward: forward)
  }

  private let unreachable: MCPDispatcher.Forward = { _ in
    throw AgentSocketError.system(call: "connect", errno: ENOENT)
  }

  func testLegacyInitializeEchoesASupportedVersion() throws {
    let reply = try XCTUnwrap(
      dispatcher(unreachable).handle(
        request("initialize", params: ["protocolVersion": "2025-06-18", "capabilities": [:]])))
    XCTAssertEqual(reply["result"]?["protocolVersion"], "2025-06-18")
    XCTAssertEqual(reply["result"]?["serverInfo"]?["name"], "maple")
    XCTAssertNotNil(reply["result"]?["capabilities"]?["tools"])
  }

  func testLegacyInitializeWithUnknownVersionOffersTheNewestLegacyVersion() throws {
    let reply = try XCTUnwrap(
      dispatcher(unreachable).handle(
        request("initialize", params: ["protocolVersion": "2024-11-05"])))
    XCTAssertEqual(reply["result"]?["protocolVersion"], "2025-11-25")
  }

  func testModernDiscoverAndUnsupportedVersionError() throws {
    let meta: JSONValue = ["_meta": ["io.modelcontextprotocol/protocolVersion": "2026-07-28"]]
    let discover = try XCTUnwrap(
      dispatcher(unreachable).handle(request("server/discover", params: meta)))
    XCTAssertEqual(discover["result"]?["resultType"], "complete")
    XCTAssertEqual(
      discover["result"]?["supportedVersions"], ["2026-07-28", "2025-11-25", "2025-06-18"])

    let bad: JSONValue = ["_meta": ["io.modelcontextprotocol/protocolVersion": "1900-01-01"]]
    let error = try XCTUnwrap(dispatcher(unreachable).handle(request("tools/list", params: bad)))
    XCTAssertEqual(error["error"]?["code"], -32022)
    XCTAssertEqual(error["error"]?["data"]?["requested"], "1900-01-01")
  }

  func testNotificationsGetNoReplyAndUnknownMethodsAreJSONRPCErrors() throws {
    let d = dispatcher(unreachable)
    XCTAssertNil(d.handle(["jsonrpc": "2.0", "method": "notifications/initialized"]))
    XCTAssertEqual(d.handle(request("bogus"))?["error"]?["code"], -32601)
    XCTAssertEqual(d.handle(["id": 1, "method": "ping"])?["error"]?["code"], -32600)
  }

  func testToolListHasSchemasAndAnnotations() throws {
    let reply = try XCTUnwrap(dispatcher(unreachable).handle(request("tools/list")))
    guard case .array(let tools) = reply["result"]?["tools"] else { return XCTFail("no tools") }
    XCTAssertEqual(
      Set(tools.compactMap { $0["name"]?.stringValue }),
      [
        "maple_get_active_photo", "maple_set_adjustments", "maple_render_and_inspect", "maple_undo",
        "maple_reset",
      ])
    for tool in tools {
      XCTAssertEqual(tool["inputSchema"]?["type"], "object", "\(tool)")
      XCTAssertEqual(tool["outputSchema"]?["type"], "object", "\(tool)")
      XCTAssertNotNil(tool["annotations"]?["readOnlyHint"], "\(tool)")
    }
    let reset = tools.first { $0["name"] == "maple_reset" }
    XCTAssertEqual(reset?["annotations"]?["destructiveHint"], true)
  }

  func testSuccessfulCallReturnsStructuredContentTextAndImage() throws {
    var forwarded: AgentRequest?
    let d = dispatcher { request in
      forwarded = request
      return AgentResponse(
        id: request.id,
        outcome: .success(
          AgentPayload(
            result: ["revision": "r2"],
            image: AgentImage(data: Data([1, 2]), mimeType: "image/jpeg"))))
    }
    let reply = try XCTUnwrap(
      d.handle(
        request(
          "tools/call",
          params: ["name": "maple_render_and_inspect", "arguments": ["max_edge": 512]])))

    XCTAssertEqual(forwarded?.tool, "maple_render_and_inspect")
    XCTAssertEqual(forwarded?.arguments["max_edge"], 512)
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

  func testAppErrorsBecomeReadableToolErrorsNotProtocolErrors() throws {
    let d = dispatcher { request in
      AgentResponse(
        id: request.id,
        outcome: .failure(
          AgentError(code: "invalid_arguments", message: "`exposure` = 9.0 is outside -4.0…4.0")))
    }
    let reply = try XCTUnwrap(
      d.handle(request("tools/call", params: ["name": "maple_set_adjustments", "arguments": [:]])))
    XCTAssertNil(reply["error"])
    XCTAssertEqual(reply["result"]?["isError"], true)
    XCTAssertEqual(
      reply["result"]?["content"],
      [["type": "text", "text": "invalid_arguments: `exposure` = 9.0 is outside -4.0…4.0"]])
  }

  func testMapleNotRunningIsAClearToolErrorWithNoFallback() throws {
    let reply = try XCTUnwrap(
      dispatcher(unreachable).handle(
        request("tools/call", params: ["name": "maple_get_active_photo"])))
    XCTAssertEqual(reply["result"]?["isError"], true)
    let text = reply["result"]?["content"].flatMap { content -> String? in
      guard case .array(let items) = content else { return nil }
      return items.first?["text"]?.stringValue
    }
    XCTAssertTrue(text?.hasPrefix("maple_unavailable: Maple isn't running") ?? false, text ?? "")
  }

  func testUnknownToolIsAnInvalidParamsError() throws {
    let reply = try XCTUnwrap(
      dispatcher(unreachable).handle(request("tools/call", params: ["name": "rm_rf"])))
    XCTAssertEqual(reply["error"]?["code"], -32602)
  }
}
