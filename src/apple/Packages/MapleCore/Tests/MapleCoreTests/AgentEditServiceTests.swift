// AgentEditServiceTests — the live agent bridge contract: an agent edit is
// one undo entry through the same transaction the sliders use, stale
// revisions and out-of-range values change nothing, and the result reaches
// a REAL .xmp through the app's own sidecar store.

import MapleAgentWire
import XCTest

@testable import MapleCore

@MainActor
final class AgentEditServiceTests: XCTestCase {
  private static let syntheticDNG: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
  }()

  private func makeSession() -> EditSession {
    EditSession(
      asset: AssetRef(displayName: "t.dng", hintExtension: "dng") { Data() },
      model: .default, culling: CullingState())
  }

  private func call(
    _ service: AgentEditService, _ tool: String, _ arguments: [String: JSONValue] = [:]
  ) async -> Result<AgentPayload, AgentError> {
    await service.handle(AgentRequest(id: 1, tool: tool, arguments: arguments)).outcome
  }

  private func revision(_ service: AgentEditService) async throws -> String {
    let state = try await call(service, "maple_get_active_photo").get().result
    return try XCTUnwrap(state["revision"]?.stringValue)
  }

  func testNoActivePhotoIsAReadableError() async {
    let outcome = await call(AgentEditService(), "maple_get_active_photo")
    guard case .failure(let error) = outcome else { return XCTFail("expected failure") }
    XCTAssertEqual(error.code, "no_active_photo")
  }

  func testActivePhotoDescribesSlidersWithGeneratedRanges() async throws {
    let service = AgentEditService()
    let session = makeSession()
    service.activate(session)

    let state = try await call(service, "maple_get_active_photo").get().result

    XCTAssertEqual(state["photo_id"]?.stringValue, session.asset.id.uuidString)
    XCTAssertEqual(state["file_name"], "t.dng")
    XCTAssertEqual(
      state["adjustments"]?["exposure"]?["min"], .number(AdjustmentModel.exposureRange.lowerBound))
    XCTAssertEqual(
      state["adjustments"]?["exposure"]?["max"], .number(AdjustmentModel.exposureRange.upperBound))
    XCTAssertEqual(
      state["adjustments"]?["temperature"]?["value"], .number(session.model.temperature))
    XCTAssertNil(state["adjustments"]?["wb_sample_x"], "provenance fields are not agent-settable")
  }

  func testSetAdjustmentsIsOneLabelledUndoEntry() async throws {
    let service = AgentEditService()
    let session = makeSession()
    service.activate(session)
    let before = session.model

    let result = try await call(
      service, "maple_set_adjustments",
      [
        "expected_revision": .string(try await revision(service)),
        "adjustments": ["exposure": 0.5, "highlights": -40],
        "description": "Recover sky",
      ]
    ).get().result

    XCTAssertEqual(session.model.exposure, 0.5)
    XCTAssertEqual(session.model.highlights, -40)
    XCTAssertEqual(result["applied"], ["exposure": 0.5, "highlights": -40])
    XCTAssertEqual(result["revision"]?.stringValue, AgentEditService.revision(of: session))
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.undoHistory.last?.description, "AI: Recover sky")
    session.undo()
    XCTAssertEqual(session.model, before)
  }

  func testStaleRevisionAppliesNothingAndReturnsCurrentState() async throws {
    let service = AgentEditService()
    let session = makeSession()
    service.activate(session)
    let seen = try await revision(service)
    session.beginEdit(description: "Manual")
    session.model.contrast = 20
    session.endEdit()

    let outcome = await call(
      service, "maple_set_adjustments",
      ["expected_revision": .string(seen), "adjustments": ["exposure": 1]])

    guard case .failure(let error) = outcome else { return XCTFail("expected failure") }
    XCTAssertEqual(error.code, "stale_revision")
    XCTAssertEqual(error.details?["adjustments"]?["contrast"]?["value"], 20)
    XCTAssertEqual(session.model.exposure, AdjustmentModel.default.exposure)
    XCTAssertEqual(session.undoHistory.count, 1)
  }

  func testSwitchingPhotosInvalidatesTheRevision() async throws {
    let service = AgentEditService()
    let first = makeSession()
    service.activate(first)
    let seen = try await revision(service)
    let second = makeSession()
    service.activate(second)

    let outcome = await call(
      service, "maple_set_adjustments",
      ["expected_revision": .string(seen), "adjustments": ["exposure": 1]])

    guard case .failure(let error) = outcome else { return XCTFail("expected failure") }
    XCTAssertEqual(error.code, "stale_revision")
    XCTAssertEqual(second.model.exposure, AdjustmentModel.default.exposure)
  }

  func testOutOfRangeAndUnknownSlidersAreRejectedNotClamped() async throws {
    let service = AgentEditService()
    let session = makeSession()
    service.activate(session)

    let outcome = await call(
      service, "maple_set_adjustments",
      [
        "expected_revision": .string(try await revision(service)),
        "adjustments": ["exposure": 9, "sparkle": 1, "contrast": 10],
      ])

    guard case .failure(let error) = outcome else { return XCTFail("expected failure") }
    XCTAssertEqual(error.code, "invalid_arguments")
    XCTAssertTrue(error.message.contains("`exposure` = 9.0 is outside -4.0…4.0"), error.message)
    XCTAssertTrue(error.message.contains("`sparkle` is not an adjustable slider"), error.message)
    XCTAssertEqual(session.model, .default, "a partially valid patch applies nothing")
    XCTAssertTrue(session.undoHistory.isEmpty)
  }

  func testUndoAndResetRequireTheCurrentRevision() async throws {
    let service = AgentEditService()
    let session = makeSession()
    service.activate(session)
    let edited = try await call(
      service, "maple_set_adjustments",
      ["expected_revision": .string(try await revision(service)), "adjustments": ["shadows": 30]]
    ).get().result

    let undone = try await call(
      service, "maple_undo", ["expected_revision": try XCTUnwrap(edited["revision"])]
    ).get().result
    XCTAssertEqual(session.model.shadows, AdjustmentModel.default.shadows)

    let staleUndo = await call(
      service, "maple_undo", ["expected_revision": try XCTUnwrap(edited["revision"])])
    guard case .failure(let error) = staleUndo else { return XCTFail("expected failure") }
    XCTAssertEqual(error.code, "stale_revision")

    session.redo()
    let reset = try await call(
      service, "maple_reset", ["expected_revision": .string(AgentEditService.revision(of: session))]
    ).get().result
    XCTAssertEqual(session.model.shadows, AdjustmentModel.default.shadows)
    XCTAssertEqual(session.undoHistory.last?.kind, .reset)
    XCTAssertEqual(reset["revision"]?.stringValue, AgentEditService.revision(of: session))
    XCTAssertEqual(reset["revision"], undone["revision"], "same state, same revision")
  }

  func testTemperatureEditTakesTheAuthoredWhiteBalancePath() async throws {
    let service = AgentEditService()
    let session = makeSession()
    service.activate(session)

    _ = try await call(
      service, "maple_set_adjustments",
      [
        "expected_revision": .string(try await revision(service)),
        "adjustments": ["temperature": 4800],
      ]
    ).get()

    XCTAssertEqual(session.model.temperature, 4800)
    XCTAssertEqual(session.model.whiteBalancePreset, .custom)
  }

  func testAgentEditOverTheSocketPersistsToARealSidecar() async throws {
    let dir = try SidecarContractIO.makeTempDirectory(prefix: "agent-bridge")
    let raw = dir.appendingPathComponent("grey.dng")
    try FileManager.default.copyItem(at: Self.syntheticDNG, to: raw)
    let session = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
    let service = AgentEditService()
    service.activate(session)
    let controller = AgentBridgeController(service: service)
    let socket = URL(fileURLWithPath: "/tmp/agent-\(UUID().uuidString.prefix(8)).sock").path
    controller.start(path: socket)
    defer { controller.stop() }
    XCTAssertTrue(controller.isListening, controller.lastError ?? "")

    let client = AgentSocketClient(path: socket, timeout: 10)
    let state = try await Task.detached {
      try client.send(AgentRequest(id: 1, tool: "maple_get_active_photo", arguments: [:]))
    }.value.outcome.get().result
    let seen = try XCTUnwrap(state["revision"])
    let edited = try await Task.detached {
      try client.send(
        AgentRequest(
          id: 2, tool: "maple_set_adjustments",
          arguments: ["expected_revision": seen, "adjustments": ["exposure": 1.25, "whites": -12]]))
    }.value.outcome.get().result
    XCTAssertEqual(edited["applied"]?["exposure"], 1.25)

    for _ in 0..<5 { await Task.yield() }
    await session.flushPendingSidecarWrite()
    let reopened = EditSession(asset: AssetRef(url: raw), model: .default, culling: CullingState())
    await reopened.loadSidecar()
    XCTAssertEqual(reopened.model.exposure, 1.25)
    XCTAssertEqual(reopened.model.whites, -12)
  }
}
