// AgentSidecarReadinessTests — agent culling and edit tools refuse a session
// whose sidecar has not loaded, or failed to load, instead of persisting
// defaults over it (#4710). Real .xmp files beside the synthetic DNG.

import MapleAgentWire
import XCTest

@testable import MapleCore

@MainActor
final class AgentSidecarReadinessTests: EditorTestCase {
  private static let syntheticDNG: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
  }()

  private static let unreadableSidecar = Data([0xFF, 0xFE, 0xFD, 0x00, 0xC3])

  private func makeRaw() throws -> URL {
    let dir = try SidecarContractIO.makeTempDirectory(prefix: "agent-readiness")
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    let raw = dir.appendingPathComponent("grey.dng")
    try FileManager.default.copyItem(at: Self.syntheticDNG, to: raw)
    return raw
  }

  private func saveExposure(_ exposure: Double, stars: Int, beside raw: URL) async throws {
    var model = AdjustmentModel.default
    model.exposure = exposure
    try await XMPSidecarStore(rawURL: raw).writeConfirmed(
      model: model, culling: CullingState(stars: stars))
  }

  /// The adapter holds its browse model weakly, as AppShell does.
  private var browseModels: [BrowseViewModel] = []

  private func adapter(for session: EditSession) -> AppShellBrowseAdapter {
    let browse = BrowseViewModel()
    browse.assets = [session.asset]
    browseModels.append(browse)
    return AppShellBrowseAdapter(
      browseVM: browse, getSessions: { [session.asset.id: session] },
      ensureSessionHandler: { _ in session })
  }

  private func setAdjustments(_ service: AgentEditService, _ session: EditSession) async
    -> Result<AgentPayload, AgentError>
  {
    await service.handle(
      AgentRequest(
        id: 1, tool: "maple_set_adjustments",
        arguments: [
          "expected_revision": .string(AgentEditService.revision(of: session)),
          "adjustments": ["exposure": 3],
        ])
    ).outcome
  }

  func testRatingOverAnUnreadableSidecarFailsWithoutWriting() async throws {
    let raw = try makeRaw()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try Self.unreadableSidecar.write(to: sidecar)
    let session = EditSession(asset: AssetRef(url: raw))

    do {
      _ = try await adapter(for: session).updateCulling(assetID: session.asset.id) {
        $0.stars = 5
      }
      XCTFail("a rating over an unreadable sidecar must be refused")
    } catch let error as AgentError {
      XCTAssertEqual(error.code, "sidecar_unavailable")
    }
    XCTAssertEqual(session.culling.stars, 0)
    XCTAssertEqual(try Data(contentsOf: sidecar), Self.unreadableSidecar)
  }

  func testCancelledRatingChangesNothing() async throws {
    let raw = try makeRaw()
    try await saveExposure(1.5, stars: 2, beside: raw)
    let session = EditSession(asset: AssetRef(url: raw))
    let adapter = adapter(for: session)

    let rating = Task { @MainActor in
      try await adapter.updateCulling(assetID: session.asset.id) { $0.stars = 5 }
    }
    rating.cancel()
    do {
      _ = try await rating.value
      XCTFail("a cancelled rating must not report success")
    } catch is CancellationError {}
    await session.flushPendingSidecarWrite()

    let (model, culling) = try XMPParser.parse(data: Data(contentsOf: SidecarPath.sidecarURL(for: raw)))
    XCTAssertEqual(model.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(culling.stars, 2)
    XCTAssertNotEqual(session.culling.stars, 5)
  }

  func testRatingOnAnUnloadedSessionMergesOverSavedEdits() async throws {
    let raw = try makeRaw()
    try await saveExposure(1.5, stars: 2, beside: raw)
    let session = EditSession(asset: AssetRef(url: raw))

    let culling = try await adapter(for: session).updateCulling(assetID: session.asset.id) {
      $0.stars = 5
    }

    XCTAssertEqual(culling.stars, 5)
    let (model, saved) = try XMPParser.parse(data: Data(contentsOf: SidecarPath.sidecarURL(for: raw)))
    XCTAssertEqual(model.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(saved.stars, 5)
  }

  func testEditToolsRejectASessionThatHasNotLoaded() async throws {
    let raw = try makeRaw()
    try await saveExposure(1.5, stars: 2, beside: raw)
    let session = EditSession(asset: AssetRef(url: raw))
    let service = AgentEditService()
    service.activate(session)

    guard case .failure(let error) = await setAdjustments(service, session) else {
      return XCTFail("an edit on unloaded defaults must be refused")
    }
    XCTAssertEqual(error.code, "not_ready")
    XCTAssertEqual(session.model.exposure, 0, accuracy: 1e-9)

    await session.loadSidecar()
    guard case .success = await setAdjustments(service, session) else {
      return XCTFail("a loaded session accepts edits")
    }
    XCTAssertEqual(session.model.exposure, 3, accuracy: 1e-9)
  }

  func testEditToolsRejectASessionWhoseLoadFailed() async throws {
    let raw = try makeRaw()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try Self.unreadableSidecar.write(to: sidecar)
    let session = EditSession(asset: AssetRef(url: raw))
    await session.loadSidecar()
    let service = AgentEditService()
    service.activate(session)

    guard case .failure(let error) = await setAdjustments(service, session) else {
      return XCTFail("an edit after a failed load must be refused")
    }
    XCTAssertEqual(error.code, "sidecar_unavailable")
    let described = await service.handle(
      AgentRequest(id: 2, tool: "maple_get_active_photo", arguments: [:])
    ).outcome
    guard case .failure(let readError) = described else {
      return XCTFail("the active photo's state is unknown while its sidecar is unreadable")
    }
    XCTAssertEqual(readError.code, "sidecar_unavailable")
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try Data(contentsOf: sidecar), Self.unreadableSidecar)
  }
}
