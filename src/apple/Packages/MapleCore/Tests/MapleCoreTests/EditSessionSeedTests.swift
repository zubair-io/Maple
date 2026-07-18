// EditSessionSeedTests.swift — cold-open preview-seed behavior.
//
// The thumbnail canvas seed (#2040) and the cached-preview seed's
// viewport-race retry (#2041), exercised against real files in temp
// directories per the no-mocks sidecar/cache convention. Split out of
// EditSessionTests.swift for the file-size budget; the session/model
// behavior tests stay there.

import XCTest
@testable import MapleCore

@MainActor
final class EditSessionSeedTests: XCTestCase {

    // MARK: - Thumbnail canvas seed (#2040)

    /// Helper: write a throwaway asset file + a matching AVIF-encoded
    /// thumbnail into `ThumbnailDiskCache`'s sync-peek NSCache under the
    /// same key `seedFromThumbnailIfAvailable` derives (asset basename).
    /// Mirrors what a real browse-grid cell load leaves behind before the
    /// user taps into the editor.
    private func makeSessionWithHotThumbnail(
        color: CIColor, size: CGSize = CGSize(width: 64, height: 64)
    ) async throws -> EditSession {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let assetURL = tmp.appendingPathComponent("thumb-seed-\(UUID().uuidString).dng")
        try Data([0x44, 0x4E, 0x47]).write(to: assetURL)

        let swatch = CIImage(color: color).cropped(to: CGRect(origin: .zero, size: size))
        let data = ThumbnailEncoder.encode(swatch, ctx: CIContext())
        XCTAssertNotNil(data, "test setup: AVIF encode must succeed")
        await ThumbnailDiskCache.shared.storeThumbnailData(data!, for: assetURL)

        return await EditSession(asset: AssetRef(url: assetURL))
    }

    /// The core #2040 contract: when a browse-grid thumbnail is already hot
    /// in `ThumbnailDiskCache`'s sync-peek cache, `seedFromThumbnailIfAvailable`
    /// publishes it to `renderedPreview` synchronously (no `await` inside the
    /// function at all) and marks it as a non-full, thumbnail-only seed so it
    /// can never reach the persist gates.
    func testThumbnailSeedPublishesSynchronouslyAsNonFullSeed() async throws {
        let session = try await makeSessionWithHotThumbnail(color: .red)

        session.seedFromThumbnailIfAvailable()

        XCTAssertNotNil(session.renderedPreview, "hot thumbnail must publish as the initial canvas preview")
        XCTAssertFalse(session.previewIsFullRender, "a thumbnail seed must never look like a full render to the persist gates")
        XCTAssertTrue(session.previewIsThumbnailSeed, "must be flagged as a thumbnail-only seed")
    }

    /// Must never clobber a richer seed or a real render — the ordering
    /// invariant the ticket calls out explicitly. Simulates a real render
    /// (or any richer seed) having already landed by hand-setting
    /// `renderedPreview`/`previewIsFullRender` before the thumbnail seed runs.
    func testThumbnailSeedNeverOverwritesExistingPreview() async throws {
        let session = try await makeSessionWithHotThumbnail(color: .red)

        let existing = CIImage(color: .green)
            .cropped(to: CGRect(x: 0, y: 0, width: 800, height: 600))
        session.renderedPreview = existing
        session.previewIsFullRender = true

        session.seedFromThumbnailIfAvailable()

        // If the thumbnail seed had incorrectly overwritten `renderedPreview`,
        // it would also have forced `previewIsFullRender` back to false — that
        // flip is the deterministic tell, since two CIImage recipes aren't
        // directly comparable for equality.
        XCTAssertTrue(session.previewIsFullRender, "a real render already on screen must survive the thumbnail seed untouched")
        XCTAssertFalse(session.previewIsThumbnailSeed, "the flag must stay false — nothing thumbnail-only is showing")
    }

    /// The seed-ordering fix this ticket needed: `seedFromCachedPreview`'s
    /// "don't clobber something already better" guard used to be a bare
    /// `renderedPreview == nil` check, which would have permanently locked in
    /// the (coarser) thumbnail seed and starved the richer cached-preview seed
    /// from ever landing. `previewIsThumbnailSeed` is the escape hatch: the
    /// cached preview must still win once it's available.
    func testCachedPreviewSeedOverwritesThumbnailSeed() async throws {
        let session = try await makeSessionWithHotThumbnail(color: .red)
        let assetURL = session.asset.primaryURL!

        await RenderedPreviewCache.shared.configure(
            folderURL: assetURL.deletingLastPathComponent()
        )
        session.previewSize = CGSize(width: 800, height: 600)
        let richer = CIImage(color: .blue)
            .cropped(to: CGRect(x: 0, y: 0, width: 800, height: 600))
        await RenderedPreviewCache.shared.storePreview(richer, for: assetURL, screenWidth: 800)

        // Thumbnail lands first, exactly as `ensureRenderStarted` would do it.
        session.seedFromThumbnailIfAvailable()
        XCTAssertTrue(session.previewIsThumbnailSeed, "test setup: thumbnail seed must have landed first")

        let accepted = await session.seedFromCachedPreview(for: session.asset)

        XCTAssertTrue(accepted, "the richer cached preview must be allowed to overwrite a thumbnail-only seed")
        XCTAssertFalse(session.previewIsThumbnailSeed, "the flag must clear once the richer seed lands")
        XCTAssertFalse(session.previewIsFullRender, "a cache seed is still not a full render — persist gates must stay shut")
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

    // MARK: - Cached-preview seed / zero-viewport race (#2041)

    /// `seedFromCachedPreview` buckets its `RenderedPreviewCache` lookup on
    /// `previewSize.width`. `ensureRenderStarted()` can fire before the
    /// canvas lays out and pushes the real viewport (documented race on that
    /// method's doc comment — `CanvasZoomController.viewportChanged` hasn't
    /// run yet), so the very first attempt can see `previewSize == .zero`.
    /// Looking that up would bucket on a bogus `screenWidth == 1`, which can
    /// never match a previous session's real-width entry — a guaranteed
    /// miss, not a real one. This verifies the miss doesn't permanently
    /// consume the seed slot, and that once `previewSize` seeds to the real
    /// width the retry lands the cached preview instead of falling through
    /// to the slow decode path.
    func testCachedPreviewSeedRetriesAfterZeroViewportRace() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        await RenderedPreviewCache.shared.configure(folderURL: tmp)

        let assetURL = tmp.appendingPathComponent("race.dng")
        try Data([0x44, 0x4E, 0x47]).write(to: assetURL)
        let asset = AssetRef(url: assetURL)

        // Simulate a PREVIOUS session's develop, cached under the real
        // (non-degenerate) viewport width a canvas would actually report.
        let realWidth = 823
        let cachedSwatch = CIImage(color: CIColor(red: 0.2, green: 0.4, blue: 0.6))
            .cropped(to: CGRect(x: 0, y: 0, width: realWidth, height: 550))
        await RenderedPreviewCache.shared.storePreview(
            cachedSwatch, for: assetURL, screenWidth: realWidth)

        let session = await EditSession(asset: asset)

        // First attempt: previewSize is still the default `.zero` — exactly
        // the state `ensureRenderStarted()` can race into. The lookup must
        // neither hit (screenWidth=1 can't match the realWidth entry) nor
        // consume the seed slot — it must flag a retry instead.
        let firstAttemptHit = await session.seedFromCachedPreview(for: asset)
        XCTAssertFalse(firstAttemptHit,
            "a zero-viewport lookup can never match a real-width cache entry")
        let renderedAfterFirstAttempt = await session.renderedPreview
        XCTAssertNil(renderedAfterFirstAttempt,
            "a degenerate-width miss must not publish anything")
        let pendingAfterFirstAttempt = await session.cachedPreviewSeedPendingViewport
        XCTAssertTrue(pendingAfterFirstAttempt,
            "the zero-viewport miss must flag a retry (#2041)")

        // The real viewport lands (`CanvasZoomController.viewportChanged`
        // equivalent) — `previewSize`'s `didSet` must re-attempt the seed
        // with the now-correct width and land the cached preview.
        await MainActor.run {
            session.previewSize = CGSize(width: realWidth, height: 550)
        }

        let deadline = Date().addingTimeInterval(2.0)
        while Date() < deadline {
            if await session.renderedPreview != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }

        let landed = await session.renderedPreview
        XCTAssertNotNil(landed,
            "the cached preview must land once previewSize seeds to the real width")
        XCTAssertEqual(landed?.extent.width ?? 0, CGFloat(realWidth), accuracy: 0.5,
            "the retried seed must publish the cache-stored preview, not a stray render")
        let pendingAfterRetry = await session.cachedPreviewSeedPendingViewport
        XCTAssertFalse(pendingAfterRetry, "the retry must fire at most once per cold-open")
    }

    /// The jules-review edge on top of the race above: a SUB-PIXEL layout
    /// transient lands first (0 → 0.5). That takes the didSet's
    /// zero-transition branch and fires the retry, which fails the seed's
    /// `width >= 1` guard and RE-ARMS the pending flag. The real width then
    /// arrives with `oldValue == 0.5` — the non-zero branch — so a retry
    /// gated on `oldValue == .zero` would never fire again and the cache
    /// miss would be permanent. The retry call therefore runs on EVERY
    /// `previewSize` update (its pending-flag guard makes that free); this
    /// walks the full 0 → 0.5 → real-width sequence and asserts the cached
    /// preview still lands.
    func testCachedPreviewSeedSurvivesSubPixelViewportTransient() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        await RenderedPreviewCache.shared.configure(folderURL: tmp)

        let assetURL = tmp.appendingPathComponent("transient.dng")
        try Data([0x44, 0x4E, 0x47]).write(to: assetURL)
        let asset = AssetRef(url: assetURL)

        let realWidth = 823
        let cachedSwatch = CIImage(color: CIColor(red: 0.7, green: 0.3, blue: 0.1))
            .cropped(to: CGRect(x: 0, y: 0, width: realWidth, height: 550))
        await RenderedPreviewCache.shared.storePreview(
            cachedSwatch, for: assetURL, screenWidth: realWidth)

        let session = await EditSession(asset: asset)

        // Cold-open attempt at .zero — arms the pending flag.
        let zeroHit = await session.seedFromCachedPreview(for: asset)
        XCTAssertFalse(zeroHit)
        let pendingAfterZero = await session.cachedPreviewSeedPendingViewport
        XCTAssertTrue(pendingAfterZero, "precondition: zero-width attempt arms the retry")

        // Sub-pixel layout-churn transient (0 → 0.5): the didSet's retry
        // fires, fails the `width >= 1` guard, and must RE-ARM the flag
        // rather than burn the one shot. Poll for the re-arm — the retry
        // body is an async hop off the didSet.
        await MainActor.run {
            session.previewSize = CGSize(width: 0.5, height: 550)
        }
        let rearmDeadline = Date().addingTimeInterval(2.0)
        while Date() < rearmDeadline {
            if await session.cachedPreviewSeedPendingViewport { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let pendingAfterTransient = await session.cachedPreviewSeedPendingViewport
        XCTAssertTrue(pendingAfterTransient,
            "a sub-pixel retry must re-arm the pending flag, not consume it (#2041)")
        let renderedAfterTransient = await session.renderedPreview
        XCTAssertNil(renderedAfterTransient,
            "a sub-pixel-width lookup must not publish anything")

        // Real width lands with oldValue == 0.5 — the NON-zero didSet
        // branch. The retry must still fire and land the cached preview.
        await MainActor.run {
            session.previewSize = CGSize(width: realWidth, height: 550)
        }
        let deadline = Date().addingTimeInterval(2.0)
        while Date() < deadline {
            if await session.renderedPreview != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }

        let landed = await session.renderedPreview
        XCTAssertNotNil(landed,
            "the cached preview must land after a sub-pixel transient — a retry gated on "
            + "oldValue == .zero strands the pending flag forever (jules review, #2041)")
        XCTAssertEqual(landed?.extent.width ?? 0, CGFloat(realWidth), accuracy: 0.5,
            "the retried seed must publish the cache-stored preview")
        let pendingAfterLanding = await session.cachedPreviewSeedPendingViewport
        XCTAssertFalse(pendingAfterLanding, "a landed seed must clear the pending flag")
    }
}

