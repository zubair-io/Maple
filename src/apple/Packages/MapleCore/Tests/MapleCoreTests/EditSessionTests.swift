import XCTest
@testable import MapleCore

@MainActor
final class EditSessionTests: XCTestCase {
    func testInitialModelSeedsAsShotWhiteBalanceWhenNoSidecarExists() {
        let model = EditSession.initialModel(
            loadedModel: nil,
            asShotCCT: 4875,
            asShotTint: 14
        )

        XCTAssertEqual(model.temperature, 4875, accuracy: 0.01)
        XCTAssertEqual(model.tint, 14, accuracy: 0.01)
    }

    func testInitialModelPreservesSidecarWhiteBalanceWhenSidecarExists() {
        var sidecarModel = AdjustmentModel.default
        sidecarModel.temperature = 3200
        sidecarModel.tint = -8

        let model = EditSession.initialModel(
            loadedModel: sidecarModel,
            asShotCCT: 4875,
            asShotTint: 14
        )

        XCTAssertEqual(model.temperature, 3200, accuracy: 0.01)
        XCTAssertEqual(model.tint, -8, accuracy: 0.01)
    }

    func testLoadSidecarDoesNotRenderInactivePrimedSession() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let rawURL = dir.appendingPathComponent("inactive.dng")
        try Data("not a raw file".utf8).write(to: rawURL)

        var persistedModel = AdjustmentModel.default
        persistedModel.exposure = 0.75
        let persistedCulling = CullingState(stars: 4, flag: .pick)
        let store = XMPSidecarStore(rawURL: rawURL)
        await store.update(model: persistedModel, culling: persistedCulling)
        await store.flush()

        let session = EditSession(asset: AssetRef(url: rawURL))
        await session.loadSidecar()

        XCTAssertEqual(session.model.exposure, 0.75, accuracy: 0.01)
        XCTAssertEqual(session.culling.stars, 4)
        XCTAssertEqual(session.culling.flag, .pick)

        try await Task.sleep(for: .milliseconds(200))

        XCTAssertNil(session.renderedPreview)
        XCTAssertNil(session.renderError)
        XCTAssertFalse(session.isRendering)
    }
}
