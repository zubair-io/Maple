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

    // #1069 — the loading-indicator readiness predicate. The bug-encoding case:
    // on the GPU path a hydration-seeded renderedPreview must NOT count as a
    // frame on screen (the GPU canvas is the Metal layer, blank until presented).
    func testCanvasHasFrame_gpuPath_usesGpuFramePresented_notRenderedPreview() {
        // Seeded renderedPreview but no GPU present yet → no frame on screen.
        XCTAssertFalse(EditSession.canvasHasFrame(
            gpuActive: true, gpuFramePresented: false, hasRenderedPreview: true))
        // GPU has presented → frame on screen (even with renderedPreview nil).
        XCTAssertTrue(EditSession.canvasHasFrame(
            gpuActive: true, gpuFramePresented: true, hasRenderedPreview: false))
    }

    func testCanvasHasFrame_cpuPath_usesRenderedPreview() {
        XCTAssertTrue(EditSession.canvasHasFrame(
            gpuActive: false, gpuFramePresented: false, hasRenderedPreview: true))
        XCTAssertFalse(EditSession.canvasHasFrame(
            gpuActive: false, gpuFramePresented: true, hasRenderedPreview: false))
    }

    func testLoadingIndicator_visibleWhileResolvingFirstFrame() {
        // Stays visible even once a (preview) frame is on screen — the whole
        // point of #1201: don't hide just because the sub-second preview landed.
        // `isResolvingFirstFrame` stays true through the decode AND the first
        // full render, so this covers the entire cold-open wait.
        XCTAssertTrue(EditSession.shouldShowLoadingIndicator(
            isResolvingFirstFrame: true, isRendering: false, hasOnscreenFrame: true))
    }
    func testLoadingIndicator_hiddenOnceFirstFrameResolvedAndPresent() {
        XCTAssertFalse(EditSession.shouldShowLoadingIndicator(
            isResolvingFirstFrame: false, isRendering: false, hasOnscreenFrame: true))
    }
    func testLoadingIndicator_visibleInNoPreviewRenderWindow() {
        XCTAssertTrue(EditSession.shouldShowLoadingIndicator(
            isResolvingFirstFrame: false, isRendering: true, hasOnscreenFrame: false))
    }
    func testLoadingIndicator_noFlashOnTickAfterFrame() {
        // A slider tick re-renders (isRendering true) but a frame is up and the
        // cold-open already resolved → no spinner flash.
        XCTAssertFalse(EditSession.shouldShowLoadingIndicator(
            isResolvingFirstFrame: false, isRendering: true, hasOnscreenFrame: true))
    }
    func testLoadingIndicator_stillVisibleDuringPostDecodeRenderTail() {
        // The exact bug from the field logs: the decode call returned (so the
        // OLD flag would have dropped), but the first full-quality frame hasn't
        // published yet — `isResolvingFirstFrame` keeps the indicator up across
        // that render tail even though a (preview) frame is already on screen.
        XCTAssertTrue(EditSession.shouldShowLoadingIndicator(
            isResolvingFirstFrame: true, isRendering: true, hasOnscreenFrame: true))
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
            // Simulate a completed fast pass: only full-canvas renders of
            // the current model are persistable (#1881). Without this the
            // seeded buffer counts as a cold-open seed and the persist
            // path (correctly) refuses to bake it.
            session.previewIsFullRender = true
        }

        // Trigger persist via the public render path. This kicks
        // _scheduleRender(.fast) → fast publish → _scheduleRefine →
        // skip branch → persistCurrentPreviewToCache.
        session.ensureRenderStarted()

        // Poll for the cache file to appear. The persist path runs through
        // a 250 ms refine debounce, then a `.utility`-priority detached
        // task, then a JPEG encode + atomic write — most of the time this
        // lands within ~400 ms but utility QoS can queue behind unrelated
        // work under CI load. Cap at 5 s so a real bug fails fast.
        let mapleDir = tmp.appendingPathComponent(".maple/previews")
        let deadline = Date().addingTimeInterval(5.0)
        var files: [String] = []
        while Date() < deadline {
            files = (try? FileManager.default.contentsOfDirectory(atPath: mapleDir.path)) ?? []
            if !files.isEmpty { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertFalse(files.isEmpty, "RenderedPreviewCache should have written a file under .maple/previews")
    }

    /// #1881 — a preview that is NOT a completed full-canvas render of the
    /// current model (a cold-open seed, or a viewport patch composited over
    /// an older underlay) must never reach `RenderedPreviewCache`. Baking
    /// such a mixed-provenance image writes a hard tone seam that every
    /// subsequent cold open re-displays until a full render overwrites it.
    func testPersistSkipsPreviewThatIsNotAFullRender() async throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        await RenderedPreviewCache.shared.configure(folderURL: tmp)

        let assetURL = tmp.appendingPathComponent("test.dng")
        try Data([0x44, 0x4E, 0x47]).write(to: assetURL)

        let session = await EditSession(asset: AssetRef(url: assetURL))
        let scheduled = await MainActor.run {
            session.previewSize = CGSize(width: 800, height: 600)
            session.renderedPreview = CIImage(color: .red)
                .cropped(to: CGRect(x: 0, y: 0, width: 800, height: 600))
            // Default is false; set explicitly to document the contract
            // under test: seed / composite provenance blocks persistence.
            session.previewIsFullRender = false
            return session.persistCurrentPreviewToCache()
        }
        // Deterministic: the gate refuses BEFORE spawning the detached write,
        // so the returned Bool is the whole story — no sleep-and-probe.
        XCTAssertFalse(
            scheduled,
            "A non-full-render preview must not be persisted to RenderedPreviewCache (#1881)"
        )

        // And the positive control on the same session: flipping the flag is
        // the only change that may allow a persist to schedule.
        let scheduledWhenFull = await MainActor.run {
            session.previewIsFullRender = true
            return session.persistCurrentPreviewToCache()
        }
        XCTAssertTrue(scheduledWhenFull, "A full render with a valid URL must persist")
    }

    /// On a cold open (no `.maple/previews` cache hit), the embedded JPEG
    /// preview should publish to `renderedPreview` *before* the Rust
    /// decode lands — that's the difference between a 50 ms first paint
    /// and a multi-second one on a 100 MP RAW. This test captures the
    /// ordering invariant by asserting `renderedPreview != nil` within
    /// a tight window (well under any plausible Rust decode time, even
    /// on cached fixtures).
    ///
    /// Requires a real .dng with an embedded JPEG preview. Uses
    /// `test-fixtures/raws/test_0002.dng` if present; skips otherwise so
    /// CI without fixtures still runs.
    func testColdOpenPaintsEmbeddedPreviewBeforeRustDecode() async throws {
        let fixturePath = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("test-fixtures/raws/test_0002.dng")

        guard FileManager.default.fileExists(atPath: fixturePath.path) else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }

        let asset = AssetRef(url: fixturePath)
        let session = await EditSession(asset: asset)

        // Kick off the open path. ensureRenderStarted() returns
        // synchronously after spawning a Task whose body runs cache +
        // embedded-preview seeds before awaiting the Rust task. The
        // polling loop below waits for the embedded-preview seed to
        // publish to renderedPreview.
        session.ensureRenderStarted()

        // Poll for `renderedPreview` to land. Embedded preview via
        // ImageIO is ~50 ms on a healthy local machine; Rust on this
        // fixture is 3-5 s. 1500 ms ceiling is well under any plausible
        // Rust decode time but generous enough to absorb CI scheduling
        // jitter when MainActor work is queued.
        let deadline = Date().addingTimeInterval(1.5)
        while Date() < deadline {
            if await session.renderedPreview != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }

        let preview = await session.renderedPreview
        XCTAssertNotNil(preview, "Embedded preview must publish within 1500 ms; otherwise cold open regressed to wait for Rust")
    }

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

    // MARK: - setKeywords (#632)

    /// `setKeywords` updates the culling list and the change persists
    /// across an `XMPSidecarStore` flush + reload — the same write path
    /// the rating/flag mutators use.
    func testSetKeywordsRoutesThroughSidecarStore() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let rawURL = dir.appendingPathComponent("kw.dng")
        try Data("placeholder".utf8).write(to: rawURL)

        let session = EditSession(asset: AssetRef(url: rawURL))
        session.setKeywords(["paris", "travel"])
        XCTAssertEqual(session.culling.keywords, ["paris", "travel"])

        // `culling.didSet` spawns a detached Task that calls `store.update`.
        // Yield enough times for that Task to land its scheduled write
        // before we flush; otherwise `flush()` cancels the pending Task
        // before it ever calls `update()`, and nothing reaches disk.
        for _ in 0..<5 { await Task.yield() }
        await session.flushPendingSidecarWrite()

        let fresh = XMPSidecarStore(rawURL: rawURL)
        let (_, c) = try await fresh.load()
        XCTAssertEqual(c.keywords, ["paris", "travel"])
    }

    /// Duplicate + blank entries are normalized out before the list
    /// hits `culling.keywords` so the sidecar never carries
    /// `<rdf:li></rdf:li>` blanks or repeated bag members.
    func testSetKeywordsDedupesAndDropsBlanks() {
        let session = EditSession(asset: AssetRef.preview())
        session.setKeywords(["a", "  ", "b", "a", " b ", ""])
        XCTAssertEqual(session.culling.keywords, ["a", "b"])
    }

    /// No-op writes (same list) don't bump anything — verified by
    /// confirming the equality short-circuit.
    func testSetKeywordsIsIdempotent() {
        let session = EditSession(asset: AssetRef.preview())
        session.setKeywords(["a", "b"])
        let before = session.culling
        session.setKeywords(["a", "b"])
        XCTAssertEqual(session.culling, before)
    }

    // MARK: - Sidecar error propagation (#1412)

    /// Injecting a failing `SidecarStoreProtocol` via `remoteSidecarStore`
    /// triggers `sidecarError` on the session. Verifies the Task-based
    /// subscription wiring added in PR #1434.
    func testSidecarWriteErrorPropagatesFromStoreThroughSession() async throws {
        // A sourceless AssetRef (no primary URL) so EditSession doesn't
        // create an XMPSidecarStore of its own — it will use the injected one.
        let asset = AssetRef.preview()
        let store = FailingSidecarStore()
        let session = EditSession(asset: asset, remoteSidecarStore: store)

        // Yield enough times for EditSession's sidecarErrorTask to start
        // executing and call store.errors(), registering its continuation.
        // Without this yield, emitError fires before any subscriber is
        // registered and the error is lost.
        for _ in 0..<10 { await Task.yield() }

        // Ask the store to emit a write error. The session's Task subscribes
        // to `store.errors()` and should publish it to `session.sidecarError`.
        let sentinel = NSError(domain: "test.sidecar", code: 42,
                               userInfo: [NSLocalizedDescriptionKey: "disk full"])
        await store.emitError(sentinel)

        // Poll for the error to hop from the actor onto MainActor.
        let deadline = Date().addingTimeInterval(1.0)
        while Date() < deadline {
            if session.sidecarError != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }

        let received = try XCTUnwrap(session.sidecarError as NSError?)
        XCTAssertEqual(received.code, 42)
        XCTAssertEqual(received.domain, "test.sidecar")
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

// MARK: - FailingSidecarStore (test double for #1412)

/// Minimal `SidecarStoreProtocol` conformer that lets the test imperatively
/// emit errors into the async stream returned by `errors()`.
private actor FailingSidecarStore: SidecarStoreProtocol {
    private var continuations: [AsyncStream<Error>.Continuation] = []
    private var nextID: UInt64 = 0

    func load() async throws -> (AdjustmentModel, CullingState) { (.default, CullingState()) }
    func loadIfPresent() async throws -> (AdjustmentModel, CullingState)? { nil }
    func update(model: AdjustmentModel, culling: CullingState) {}
    func flush() async {}

    func errors() -> AsyncStream<Error> {
        AsyncStream { continuation in
            continuations.append(continuation)
        }
    }

    /// Emit an error into every currently open subscriber stream.
    func emitError(_ error: Error) {
        for c in continuations { c.yield(error) }
    }
}
