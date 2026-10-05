#if os(macOS)
  import Foundation
  import MapleAgentWire
  import MapleMCPHTTP
  import XCTest

  @testable import MapleCore

  @MainActor
  final class AgentHTTPIntegrationTests: XCTestCase {
    func testHTTPEditsPreserveRevisionUndoSidecarAndOriginal() async throws {
      var appleRoot = URL(fileURLWithPath: #filePath)
      for _ in 0..<5 { appleRoot.deleteLastPathComponent() }
      let fixture = appleRoot.appending(
        path:
          "MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
      let dir = try SidecarContractIO.makeTempDirectory(prefix: "agent-http")
      defer { try? FileManager.default.removeItem(at: dir) }
      let raw = dir.appendingPathComponent("grey.dng")
      try FileManager.default.copyItem(at: fixture, to: raw)
      let original = try Data(contentsOf: raw)
      let session = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
      let service = AgentEditService(exportDirectory: dir.appendingPathComponent("Exports"))
      service.activate(session)
      let server = MCPHTTPServer { request in await service.handle(request) }
      let url = try await server.start(port: 0, token: "sidecar-integration-token")
      do {
        let state = try await call(url, "maple_get_active_photo")
        let seen = try XCTUnwrap(state["structuredContent"]?["revision"])
        let edited = try await call(
          url, "maple_set_adjustments",
          ["expected_revision": seen, "adjustments": ["exposure": 1.25, "whites": -12]])
        XCTAssertEqual(edited["isError"], false)
        XCTAssertEqual(session.model.exposure, 1.25)
        XCTAssertEqual(session.undoHistory.count, 1)
        let stale = try await call(
          url, "maple_set_adjustments", ["expected_revision": seen, "adjustments": ["exposure": 2]])
        XCTAssertEqual(stale["isError"], true)
        XCTAssertEqual(session.model.exposure, 1.25)
        XCTAssertEqual(session.undoHistory.count, 1)
        await session.flushPendingSidecarWrite()
        let reopened = EditSession(
          asset: AssetRef(url: raw), model: .default, culling: CullingState())
        await reopened.loadSidecar()
        XCTAssertEqual(reopened.model.exposure, 1.25)
        XCTAssertEqual(reopened.model.whites, -12)
        let exported = try await call(
          url, "maple_export_photo",
          ["expected_revision": try XCTUnwrap(edited["structuredContent"]?["revision"])])
        XCTAssertEqual(exported["isError"], false)
        let exportPath = try XCTUnwrap(exported["structuredContent"]?["path"]?.stringValue)
        XCTAssertGreaterThan(try Data(contentsOf: URL(fileURLWithPath: exportPath)).count, 0)
        XCTAssertEqual(exported["structuredContent"]?["format"], "jpeg_srgb")
        XCTAssertEqual(session.undoHistory.count, 1)
        let undone = try await call(
          url, "maple_undo",
          ["expected_revision": try XCTUnwrap(edited["structuredContent"]?["revision"])])
        XCTAssertEqual(undone["isError"], false)
        XCTAssertEqual(session.model, .default)
        XCTAssertEqual(try Data(contentsOf: raw), original)
        await server.stop()
      } catch {
        await server.stop()
        throw error
      }
    }

    private func call(_ url: URL, _ tool: String, _ arguments: [String: JSONValue] = [:])
      async throws -> JSONValue
    {
      var request = URLRequest(url: url)
      request.httpMethod = "POST"
      request.setValue("Bearer sidecar-integration-token", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
      request.setValue("2025-11-25", forHTTPHeaderField: "MCP-Protocol-Version")
      let message: JSONValue = [
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": ["name": .string(tool), "arguments": .object(arguments)],
      ]
      request.httpBody = try message.encodedLine()
      let (data, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      return try XCTUnwrap(JSONValue.decode(data)["result"])
    }
  }
#endif
