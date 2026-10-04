import Foundation
import MapleAgentWire
import XCTest

@testable import MapleCore

#if os(macOS)
  extension AgentEditServiceTests {
    func testRealStdioBridgeEditsAndUndoesDurableXMP() async throws {
      let directory = try SidecarContractIO.makeTempDirectory(prefix: "agent-real-stdio")
      defer { try? FileManager.default.removeItem(at: directory) }
      let original = directory.appendingPathComponent("portrait.png")
      let fixture = try XCTUnwrap(
        Bundle.module.url(forResource: "portrait-skin-test", withExtension: "png"))
      try FileManager.default.copyItem(at: fixture, to: original)
      let originalBytes = try Data(contentsOf: original)
      let sidecar = SidecarPath.sidecarURL(for: original)
      try XMPSerializer.serialize(model: .default, culling: CullingState()).write(
        to: sidecar, atomically: true, encoding: .utf8)
      let session = EditSession(asset: AssetRef(url: original))
      await session.loadSidecar()
      session.previewSize = CGSize(width: 256, height: 256)
      await session.openAssetPipelineAsync()
      _ = await session.latestRenderSchedule?.value
      await session.renderActor.awaitCurrentRenderIfInFlight()
      let before = session.model
      let service = AgentEditService()
      service.activate(session)
      let controller = AgentBridgeController(service: service)
      let socket = "/tmp/maple-stdio-\(UUID().uuidString.prefix(8)).sock"
      controller.start(path: socket)
      defer { controller.stop() }
      XCTAssertTrue(controller.isListening, controller.lastError ?? "")
      var packages = URL(fileURLWithPath: #filePath)
      for _ in 0..<4 { packages.deleteLastPathComponent() }
      let bridge = packages.appendingPathComponent("MapleMCP/.build/release/maple-mcp")
      XCTAssertTrue(FileManager.default.isExecutableFile(atPath: bridge.path))
      let state = try await stdioTool("maple_get_active_photo", [:], bridge: bridge, socket: socket)
      let revision = try XCTUnwrap(state["revision"])
      let edited = try await stdioTool(
        "maple_set_adjustments",
        ["expected_revision": revision, "adjustments": ["exposure": 1.25]], bridge: bridge,
        socket: socket)
      XCTAssertEqual(session.model.exposure, 1.25)
      XCTAssertEqual(session.undoHistory.count, 1)
      await session.flushPendingSidecarWrite()
      let editedXML = try String(contentsOf: sidecar, encoding: .utf8)
      XCTAssertEqual(try XMPParser.parse(editedXML).0.exposure, 1.25)
      _ = try await stdioTool(
        "maple_undo", ["expected_revision": try XCTUnwrap(edited["revision"])], bridge: bridge,
        socket: socket)
      XCTAssertEqual(session.model, before)
      XCTAssertEqual(session.undoHistory.count, 0)
      await session.flushPendingSidecarWrite()
      let restoredXML = try String(contentsOf: sidecar, encoding: .utf8)
      XCTAssertEqual(try XMPParser.parse(restoredXML).0.exposure, before.exposure)
      XCTAssertNotEqual(restoredXML, editedXML)
      XCTAssertEqual(try Data(contentsOf: original), originalBytes)
      await session.renderActor.cancelAll()
    }

    private func stdioTool(
      _ name: String, _ arguments: [String: JSONValue], bridge: URL, socket: String
    ) async throws -> JSONValue {
      let encoded = try JSONValue.object(arguments).encodedLine()
      let data = try await Task.detached {
        try MCPStdioQualification.request(
          executable: bridge, socket: socket, tool: name, arguments: encoded)
      }.value
      let payload = try JSONValue.decode(data)
      return try XCTUnwrap(payload["structuredContent"])
    }
  }
#endif
