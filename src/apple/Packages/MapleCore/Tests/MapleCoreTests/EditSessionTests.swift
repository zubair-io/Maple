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

    /// Fit-to-window opens are the common case; if `RenderedPreviewCache`
    /// only writes on `phase == .refine` then those opens never populate
    /// the cache and every re-open redoes the Rust pipeline. Verify that
    /// after a fast pass completes in fit mode, the cache file appears
    /// on disk for the asset.
    func testFitModeRenderPersistsToPreviewCacheAfterFastPass() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        // Configure the cache against the temp dir so the write lands
        // somewhere the test can observe.
        await RenderedPreviewCache.shared.configure(folderURL: tmp)

        // A real .dng under tmp so EditSession's `assetURL` is valid for
        // mtime keying. Empty bytes are fine — the test seeds
        // `renderedPreview` directly rather than running Rust; we're
        // testing the persist path, not decode.
        let assetURL = tmp.appendingPathComponent("test.dng")
        try Data([0x44, 0x4E, 0x47]).write(to: assetURL)

        let asset = AssetRef(url: assetURL)
        let session = await EditSession(asset: asset)

        // Manually drive a fast-only render: previewSize set, pixelScale=0
        // (fit mode), seed `renderedPreview`, then exercise the public
        // render path. After the 250 ms refine debounce + the detached
        // cache write, the file should exist on disk.
        await MainActor.run {
            session.previewSize = CGSize(width: 800, height: 600)
            session.pixelScale = 0  // fit mode
            session.renderedPreview = CIImage(color: .red)
                .cropped(to: CGRect(x: 0, y: 0, width: 800, height: 600))
        }

        // Trigger persist via the public render path. This kicks
        // _scheduleRender(.fast) → fast publish → _scheduleRefine →
        // skip branch → persistCurrentPreviewToCache.
        await session.ensureRenderStarted()

        // Allow the 250 ms refine sleep + the utility-priority cache write
        // to land. Generous — cache write is ~10 ms but CI varies.
        try await Task.sleep(for: .milliseconds(1500))

        let mapleDir = tmp.appendingPathComponent(".maple/previews")
        let files = (try? FileManager.default.contentsOfDirectory(atPath: mapleDir.path)) ?? []
        XCTAssertFalse(files.isEmpty, "RenderedPreviewCache should have written a file under .maple/previews")
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
