import Foundation
import MapleAgentWire
import XCTest

@testable import MapleCore

#if os(macOS)
  extension AgentEditServiceTests {
    func testRealHTTPEditsAndUndoesDurableXMP() async throws {
      let directory = try SidecarContractIO.makeTempDirectory(prefix: "agent-real-http")
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
      try await AgentHTTPTestClient.withService(service) { client in
        let state = try await client.send(
          AgentRequest(id: 1, tool: "maple_get_active_photo", arguments: [:])
        ).outcome.get().result
        let revision = try XCTUnwrap(state["revision"])
        let edited = try await client.send(
          AgentRequest(
            id: 2, tool: "maple_set_adjustments",
            arguments: ["expected_revision": revision, "adjustments": ["exposure": 1.25]])
        ).outcome.get().result
        XCTAssertEqual(session.model.exposure, 1.25)
        XCTAssertEqual(session.undoHistory.count, 1)
        await session.flushPendingSidecarWrite()
        let editedXML = try String(contentsOf: sidecar, encoding: .utf8)
        XCTAssertEqual(try XMPParser.parse(editedXML).0.exposure, 1.25)
        _ = try await client.send(
          AgentRequest(
            id: 3, tool: "maple_undo",
            arguments: ["expected_revision": try XCTUnwrap(edited["revision"])])
        ).outcome.get()
        XCTAssertEqual(session.model, before)
        XCTAssertEqual(session.undoHistory.count, 0)
        await session.flushPendingSidecarWrite()
        let restoredXML = try String(contentsOf: sidecar, encoding: .utf8)
        XCTAssertEqual(try XMPParser.parse(restoredXML).0.exposure, before.exposure)
        XCTAssertNotEqual(restoredXML, editedXML)
        XCTAssertEqual(try Data(contentsOf: original), originalBytes)
        await session.renderActor.cancelAll()
      }
    }

  }
#endif
