// EditSessionDecodedCacheTests.swift — invariants for the decoded-image
// cache rework.
//
// EditSession caches the Rust scene-linear FFI's full-native output as
// the actor's `decodedImage` so subsequent slider/zoom/pan calls reuse
// it instead of re-crossing the FFI per tick. The load-bearing invariants:
//
//   1. Same asset twice → second open hits the cache (fresh check
//      returns true; the cold-path `sharedDecode` short-circuits).
//   2. A change to a BAKED (KEPT) field — `highlightRecovery`,
//      `captureSharpeningAmount/Sigma`, the unsharp radius/detail/masking
//      — invalidates the cache (fresh check returns false). Those bake
//      into the decoded buffer, so editing one demands a fresh decode.
//   3. (#950) A change to a STRIPPED field — exposure, nrColor,
//      sharpenAmount, WB, … — does NOT invalidate the cache. Those are
//      stripped before decode and re-applied LIVE per tick
//      (`maple_apply_scene_linear_chain`), so the decoded buffer is
//      unchanged. The old freshness key was sidecar MTIME, which the
//      750 ms-debounced autosave bumps on *every* save (including saves of
//      stripped fields), forcing a spurious ~15 s re-decode on the first
//      edit after a drag pause. #950 re-keys on the *baked* model (the
//      `stripAppleGPUStages` of the sidecar model) so only invariant-2
//      edits invalidate.
//
// These tests exercise the freshness state machine directly. The
// fixture-gated companion test `testColdOpenSecondRenderUsesCachedDecode`
// runs the full Rust decode once on a real RAW and verifies the second
// render lands in <1.5 s — proof that the FFI was not re-entered.
//
// Slice 2 of issue #194: the cache fields moved off EditSession onto
// `RenderActor`. The test surface is `session.renderActor.…` instead of
// `session.…`.

import XCTest
import CoreImage
@testable import MapleCore

@MainActor
final class EditSessionDecodedCacheTests: XCTestCase {

    // MARK: - Helpers

    /// Synthesise a temp `.dng` so `AssetRef(url:)` has a real file
    /// path to key against. Bytes don't matter for the freshness tests
    /// — they never invoke the Rust FFI; the cache fields are seeded
    /// directly via the actor's `_testSeedDecodedCache` hook.
    private func makeAsset() throws -> (asset: AssetRef, dir: URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("decoded-cache.dng")
        try Data([0x44, 0x4E, 0x47]).write(to: url)
        return (AssetRef(url: url), dir)
    }

    private func makeDecoded(_ size: CGSize = CGSize(width: 100, height: 100)) -> CIImage {
        CIImage(color: .gray)
            .cropped(to: CGRect(x: 0, y: 0, width: size.width, height: size.height))
    }

    private func writeSidecar(at url: URL, content: String = "<x:xmpmeta/>") throws -> Date {
        try content.write(to: url, atomically: true, encoding: .utf8)
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs[.modificationDate] as? Date) ?? Date()
    }

    /// Write a real XMP sidecar serialised from `model` so the freshness
    /// key (`RenderActor.bakedModel(for:)` → `stripAppleGPUStages(parse)`)
    /// sees the exact baked-vs-stripped field values under test (#950).
    @discardableResult
    private func writeSidecar(at url: URL, model: AdjustmentModel) throws -> Date {
        let xml = XMPSerializer.serialize(model: model, culling: CullingState())
        return try writeSidecar(at: url, content: xml)
    }

    // MARK: - Tests

    /// A freshly-seeded cache (no sidecar on disk) is fresh — the
    /// freshness check sees `decodedBakedModel == nil` and the live baked
    /// model is also `nil` (no sidecar on disk), so they match (#950).
    func testFreshlySeededCacheIsFreshWhenNoSidecarPresent() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100)
        )

        let populated = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertTrue(populated)
        let fresh = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(fresh,
            "cache with no sidecar at decode and no sidecar live should be fresh")
    }

    /// A freshly-seeded cache (sidecar on disk, baked model captured) is
    /// fresh while the sidecar's baked fields are unchanged (#950).
    func testFreshlySeededCacheIsFreshWhenBakedModelMatches() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }
        _ = try writeSidecar(at: sidecarURL)

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100)
        )

        let fresh = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(fresh,
            "cache baked model equal to live sidecar baked model should be fresh")
    }

    // MARK: - #950: baked vs stripped field freshness

    /// THE WIN (#950): editing a STRIPPED field (exposure / nrColor /
    /// sharpenAmount / WB) rewrites the sidecar — bumping its mtime — but
    /// does NOT change the decoded buffer (those stages are stripped before
    /// decode and re-applied live per tick). So the in-memory decode cache
    /// must stay FRESH. Under the old sidecar-mtime key this returned stale
    /// and forced a spurious ~15 s re-decode on the first edit after a
    /// drag pause; the baked-model key fixes it.
    func testStrippedFieldEditKeepsCacheFresh() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }
        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }

        // Decode-time sidecar: a non-default STRIPPED field already set.
        try writeSidecar(at: sidecarURL, model: { var m = AdjustmentModel(); m.exposure = 0.4; return m }())
        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100)
        )
        let freshBefore = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshBefore,
            "precondition: cache fresh before the stripped-field edit")

        // The autosave lands a DIFFERENT stripped-field value (the slider
        // moved). Under the baked-model key the mtime change is irrelevant;
        // no sleep needed (#950 — the cache key is the baked model, not mtime).
        try writeSidecar(at: sidecarURL, model: {
            var m = AdjustmentModel()
            m.exposure = 1.9    // exposure  — stripped
            m.nrColor = 80      // nrColor   — stripped
            m.saturation = -30  // saturation — stripped
            m.temperature = 5200 // WB        — stripped
            return m
        }())

        let freshAfter = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshAfter,
            "a stripped-field edit must NOT invalidate the decode cache (#950) — "
            + "the buffer is unchanged; the stages are re-applied live per tick")
    }

    /// The other half of #950: editing a BAKED (KEPT) field DOES change
    /// the decoded buffer (those stages run inside the decode and have no
    /// live Apple-GPU equivalent), so the cache must go STALE and force a
    /// re-decode. This is the bug we must NOT introduce by dropping mtime.
    func testKeptFieldEditInvalidatesCache() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }
        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }

        try writeSidecar(at: sidecarURL, model: AdjustmentModel())
        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100)
        )
        let freshBefore = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshBefore,
            "precondition: cache fresh before the kept-field edit")

        // highlightRecovery is a KEPT field (pre-DCP, no chain equivalent).
        // No sleep needed — freshness is keyed on the baked model, not mtime (#950).
        try writeSidecar(at: sidecarURL, model: {
            var m = AdjustmentModel(); m.highlightRecovery = .blend; return m
        }())
        let staleAfterHR = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertFalse(staleAfterHR,
            "editing highlightRecovery (a baked/KEPT field) must invalidate the "
            + "decode cache — it bakes into the buffer (#950)")

        // captureSharpeningAmount is the other classic KEPT field (runs in
        // the Rust develop, post-DCP). Re-seed, then flip it.
        // No sleep needed — freshness is keyed on the baked model, not mtime (#950).
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100))
        try writeSidecar(at: sidecarURL, model: {
            var m = AdjustmentModel(); m.highlightRecovery = .blend
            m.captureSharpeningAmount = 50; return m
        }())
        let staleAfterCS = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertFalse(staleAfterCS,
            "editing captureSharpeningAmount (a baked/KEPT field) must invalidate "
            + "the decode cache (#950)")
    }

    /// Belt-and-braces on the strip contract: a KEPT *detail* field
    /// (`sharpenRadius`) invalidates while its STRIPPED sibling
    /// (`sharpenAmount`) does not — the two live on the same tool but split
    /// across the strip boundary (`RawCoreBridge` header).
    func testSharpenRadiusKeptButAmountStripped() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }
        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }

        try writeSidecar(at: sidecarURL, model: AdjustmentModel())
        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset, decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100))

        // sharpenAmount (stripped) → still fresh.
        // No sleep needed — freshness is keyed on the baked model, not mtime (#950).
        try writeSidecar(at: sidecarURL, model: {
            var m = AdjustmentModel(); m.sharpenAmount = 120; return m
        }())
        let freshAfterAmount = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshAfterAmount,
            "sharpenAmount is stripped → no invalidation (#950)")

        // sharpenRadius (kept) → stale. Re-seed against the current sidecar
        // first so we isolate the radius change.
        await session.renderActor._testSeedDecodedCache(
            asset: asset, decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100))
        try writeSidecar(at: sidecarURL, model: {
            var m = AdjustmentModel(); m.sharpenAmount = 120; m.sharpenRadius = 2.5; return m
        }())
        let staleAfterRadius = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertFalse(staleAfterRadius,
            "sharpenRadius is KEPT → must invalidate (#950)")
    }

    /// `profile` must be normalised OUT of the baked-model freshness key:
    /// a sidecar edit that changes ONLY the profile must keep the in-memory
    /// decode cache FRESH (#950). Profile freshness is owned separately by
    /// `decodedProfile` / `profileMatches` (#871); the decode's profile
    /// comes from the live override, not the sidecar, and the autosave is
    /// debounced — so if the sidecar profile were in the key, a profile
    /// toggle would force a wasteful re-decode ~750 ms later (when the save
    /// lands) even though the #871 path already produced the right buffer.
    func testProfileOnlySidecarChangeKeepsCacheFresh() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }
        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }

        // Decode-time sidecar: explicit Neutral profile.
        try writeSidecar(at: sidecarURL, model: {
            var m = AdjustmentModel(); m.profile = .neutral; return m
        }())
        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset, decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100))
        let freshBefore = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshBefore, "precondition: cache fresh before the profile flip")

        // The debounced autosave lands the toggled profile (Neutral → Auto)
        // and NOTHING else. The baked-model key must ignore it.
        // No sleep needed — freshness is keyed on the baked model, not mtime (#950).
        try writeSidecar(at: sidecarURL, model: {
            var m = AdjustmentModel(); m.profile = .auto; return m
        }())
        let freshAfter = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshAfter,
            "a profile-only sidecar change must NOT invalidate the decode cache "
            + "(#950 / #871) — profile freshness is keyed separately via decodedProfile")
    }

    /// The per-tick fast path (#950): when the sidecar is byte-identical
    /// since decode (mtime unchanged), repeated freshness checks must return
    /// fresh — this is the common slider-drag case (the decode buffer is
    /// reused while only the stripped chain re-applies). The mtime stat
    /// short-circuits the XMP parse so the hot path stays allocation-free.
    /// Asserting many checks in a row exercises the gate; correctness is the
    /// observable contract (the perf saving is structural).
    func testUnchangedSidecarFastPathStaysFresh() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }
        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }
        try writeSidecar(at: sidecarURL, model: {
            var m = AdjustmentModel(); m.highlightRecovery = .blend; return m
        }())
        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset, decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100))

        // No sidecar write between checks → mtime unchanged → fast path.
        for tick in 0..<5 {
            let fresh = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
            XCTAssertTrue(fresh,
                "tick \(tick): an unchanged sidecar must stay fresh via the mtime fast path (#950)")
        }
    }

    /// Decoding with no sidecar (the FFI uses `AdjustmentModel::default()`,
    /// baked model captured as `nil`), then a sidecar APPEARING, must stale
    /// the cache — the decode call shape differs (null xmp_path vs a temp
    /// XMP) and the new sidecar may carry baked stages. #950 preserves this
    /// nil-vs-present edge by representing "no sidecar" as a `nil` baked
    /// model rather than `stripAppleGPUStages(.default)`.
    func testCacheIsStaleWhenSidecarAppearsAfterDecode() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }

        // Decode happened with no sidecar on disk → captured baked nil.
        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100)
        )
        let freshBefore = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshBefore,
            "precondition: cache is fresh before sidecar appears")

        // Sidecar now appears (e.g. paste-adjustments wrote one).
        _ = try writeSidecar(at: sidecarURL)
        let freshAfter = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertFalse(freshAfter,
            "a sidecar appearing where the decode captured nil should stale the cache")
    }

    /// Conversely, decoding with a sidecar present (baked model captured),
    /// then DELETING the sidecar, should also stale the cache — the cached
    /// buffer was decoded with the sidecar's baked stages, but a fresh
    /// decode would now use the default model via a null xmp_path (#950).
    func testCacheIsStaleWhenSidecarDisappearsAfterDecode() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }
        // Give the decode-time sidecar a non-default BAKED field so its
        // captured baked model is distinct from the post-delete `nil`.
        try writeSidecar(at: sidecarURL, model: {
            var m = AdjustmentModel(); m.highlightRecovery = .luminance; return m
        }())

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100)
        )
        let freshBefore = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshBefore,
            "precondition: cache is fresh before sidecar deletion")

        try FileManager.default.removeItem(at: sidecarURL)
        let freshAfter = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertFalse(freshAfter,
            "a sidecar disappearing where the decode captured a baked model should stale the cache")
    }

    /// `invalidate()` MUST clear every cache field — otherwise a follow-up
    /// populated-check would still claim "we have a cache" with stale data
    /// behind it. The `decodedBakedModel` freshness key (#950, replacing
    /// `decodedSidecarMtime`) must be among the fields cleared.
    func testInvalidateClearsAllCacheFields() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        guard let sidecarURL = asset.sidecarURL else {
            return XCTFail("file-backed asset must have a sidecar URL")
        }
        _ = try writeSidecar(at: sidecarURL)

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100),
            decodedAtModel: AdjustmentModel.default
        )
        let populated = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertTrue(populated)
        let atModel = await session.renderActor._testDecodedAtModel
        XCTAssertNotNil(atModel)

        await session.renderActor.invalidate()

        let populatedAfter = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertFalse(populatedAfter,
            "invalidate must clear decodedImage")
        let atModelAfter = await session.renderActor._testDecodedAtModel
        XCTAssertNil(atModelAfter,
            "invalidate must clear decodedAtModel")
        // After invalidate the cache is empty: `_testDecodedCachePopulated`
        // is false because `decodedForAssetID`/`decodedImage` were cleared,
        // and `decodedBakedModel` is nil. Re-seed afresh and confirm
        // freshness depends only on the new seed (proving the prior baked
        // capture didn't linger).
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100)
        )
        let freshAgain = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(freshAgain)
    }

    // MARK: - #2037: memory-pressure eviction

    /// `EditSession.releaseTransientMemory()` must empty the decoded-image
    /// cache — the same postcondition `invalidate()` already guarantees
    /// (`testInvalidateClearsAllCacheFields` above), exercised through the
    /// higher-level session API the memory-pressure fan-out actually calls.
    /// Also asserts the deep-zoom tile cache is cleared (`TileManager.clear()`
    /// empties `entries`), and that the call is idempotent / safe with no
    /// tile manager or GPU-live driver present (the common case: most
    /// sessions never zoom in and `GpuLiveFlag` may be off in this test
    /// environment).
    func testReleaseTransientMemoryEmptiesDecodedCache() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset,
            decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100),
            decodedAtModel: AdjustmentModel.default
        )
        let populatedBefore = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertTrue(populatedBefore, "precondition: decoded cache populated before eviction")

        await session.releaseTransientMemory()

        let populatedAfter = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertFalse(populatedAfter,
            "releaseTransientMemory must empty the decoded-image cache (#2037)")
        let atModelAfter = await session.renderActor._testDecodedAtModel
        XCTAssertNil(atModelAfter, "releaseTransientMemory must clear decodedAtModel too")
    }

    /// The deep-zoom tile cache is a second re-derivable buffer
    /// `releaseTransientMemory()` must free — mirrors
    /// `testTileManagerClearEmptiesCache` (`DeepZoomTileRenderingTests`) but
    /// through the session-level eviction call.
    func testReleaseTransientMemoryClearsTileManager() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        let session = EditSession(asset: asset)
        let tileManager = session.ensureTileManager()
        // Seed directly via the test-only synchronous insert — `update(...)`
        // would enqueue a real FFI fetch against the fake `.dng` bytes
        // `makeAsset()` writes, which isn't a real RAW.
        let key = TileKey(
            urlHash: TileManager.urlHash(asset.primaryURL!),
            sidecarMtime: .distantPast,
            viewTransformVersion: TileManager.viewTransformVersion,
            zoomBucket: 1,
            tileX: 0,
            tileY: 0
        )
        await tileManager.testInsertTile(key: key, image: makeDecoded())
        let countBefore = await tileManager.testCachedTileCount()
        XCTAssertEqual(countBefore, 1, "precondition: tile cache populated")

        await session.releaseTransientMemory()

        let countAfter = await tileManager.testCachedTileCount()
        XCTAssertEqual(countAfter, 0,
            "releaseTransientMemory must clear the session's deep-zoom tile cache (#2037)")
    }

    /// The common case: a browse-primed session that never zoomed in (no
    /// `tileManager`) and never opened a GPU-live session must not crash or
    /// hang — `releaseTransientMemory()` no-ops on the absent pieces.
    func testReleaseTransientMemoryIsSafeWithNoTileManagerOrGpuSession() async throws {
        let (asset, dir) = try makeAsset()
        defer { try? FileManager.default.removeItem(at: dir) }

        let session = EditSession(asset: asset)
        await session.renderActor._testSeedDecodedCache(
            asset: asset, decoded: makeDecoded(),
            rawResolution: CGSize(width: 100, height: 100))

        await session.releaseTransientMemory()

        let populatedAfter = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        XCTAssertFalse(populatedAfter)
    }

    /// Cold-open second-render parity: when fixture is present, run a
    /// real decode through `ensureRenderStarted`, wait for the Rust
    /// pass to land in the actor's cache AND the first preview to
    /// publish (proving the cold pipeline drained), then verify a
    /// second `_scheduleRender` call reuses the cache rather than
    /// re-FFIing. We can't easily count Rust calls without invasive
    /// instrumentation; instead we assert the second slider tick's
    /// publish latency is well under the cold-decode budget. On a
    /// 100 MP RAW the FFI is multi-second; a cached re-render lands in
    /// tens of milliseconds.
    func testColdOpenSecondRenderUsesCachedDecode() async throws {
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
        let session = EditSession(asset: asset)
        await MainActor.run {
            session.previewSize = CGSize(width: 1500, height: 1000)
            session.pixelScale = 0  // fit
        }
        session.ensureRenderStarted()

        // Wait up to 30 s for the cold Rust decode to populate the
        // cache AND for the first render to publish.
        let coldDeadline = Date().addingTimeInterval(30.0)
        while Date() < coldDeadline {
            let cached = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
            let isRendering = await session.isRendering
            if cached && !isRendering {
                try await Task.sleep(for: .milliseconds(300))
                break
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        let populated = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        guard populated else {
            return XCTFail("Rust decode did not populate cache within 30 s")
        }

        // Now mutate the model — this triggers `_scheduleRender(.fast)`
        // through the `model.didSet`. Time how long it takes for the
        // fast render to publish.
        let beforePreview = await session.renderedPreview
        let t0 = ContinuousClock.now
        await MainActor.run {
            session.model.exposure = 0.5
        }
        let warmDeadline = Date().addingTimeInterval(2.5)
        var publishedAfter = false
        while Date() < warmDeadline {
            let p = await session.renderedPreview
            if p !== beforePreview {
                publishedAfter = true
                break
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        let elapsed = ContinuousClock.now - t0
        let elapsedMs = Double(elapsed.components.seconds) * 1000
            + Double(elapsed.components.attoseconds) / 1e15
        XCTAssertTrue(publishedAfter, "no preview update within 2.5 s of slider tick")
        XCTAssertLessThan(elapsedMs, 1500,
            "cached slider tick should land in <1.5 s; got \(elapsedMs) ms — cache miss?")
        print("CACHED_SLIDER_TICK_MS \(elapsedMs)")
        let stillCached = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
        let stillFresh = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
        XCTAssertTrue(stillCached, "decoded cache should still be populated after a slider tick")
        XCTAssertTrue(stillFresh, "decoded cache should still be fresh after a slider tick")
    }

    /// #871: the decode buffer is profile-dependent (Auto develops
    /// auto_exposure Off; Neutral keeps it On), so the `profile` param must
    /// route through `sharedDecode` to a DISTINCT decode and the cache must
    /// re-key on it — a Neutral→Auto toggle must NOT serve the Neutral
    /// (AE-On) buffer to the Auto render. Exercises the actor concurrency
    /// surface the `decodeSceneLinear`-direct tests bypass: `decodeProfile`
    /// in the in-flight task identity, `decodedProfile`, and `snapshot.profile`.
    /// Fixture-gated on a real RAW (the FFI must actually develop AE).
    func testSharedDecodeReKeysOnProfile871() async throws {
        let fixturePath = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("test-fixtures/raws/test_0003.CR2")
        guard FileManager.default.fileExists(atPath: fixturePath.path) else {
            throw XCTSkip("test_0003.CR2 fixture not present; skipping")
        }
        let asset = AssetRef(url: fixturePath)
        let pipeline = ImageEditPipeline()
        let actor = RenderActor(pipeline: pipeline)
        let identity: @Sendable (CIImage, AssetRef) async -> CIImage = { img, _ in img }

        // Full-res decode (target nil) so a single cache slot is written.
        guard let neutral = await actor.sharedDecode(
            asset: asset, target: nil, profile: .neutral, normalize: identity
        ) else { throw XCTSkip("neutral decode nil") }
        let snapNeutral = await actor.snapshot(forAsset: asset)
        XCTAssertEqual(snapNeutral.profile, .neutral,
                       "cache must record the Neutral decode profile")

        guard let auto = await actor.sharedDecode(
            asset: asset, target: nil, profile: .auto, normalize: identity
        ) else { throw XCTSkip("auto decode nil") }
        let snapAuto = await actor.snapshot(forAsset: asset)
        XCTAssertEqual(snapAuto.profile, .auto,
                       "an Auto decode after a Neutral one must RE-KEY the cache to Auto "
                       + "(not serve the cached Neutral buffer) — #871")

        // The Auto buffer (AE-Off) must be meaningfully darker than the
        // Neutral buffer (AE-On). If the profile param were ignored / the
        // cache served the same buffer, the two means would be equal.
        func meanGreen(_ ci: CIImage) -> Double {
            let ctx = CIContext(options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!,
                .workingFormat: CIFormat.RGBAf,
            ])
            let e = ci.extent
            let w = 48, h = 48
            var px = [Float](repeating: 0, count: w * h * 4)
            px.withUnsafeMutableBytes { buf in
                ctx.render(
                    ci.transformed(by: CGAffineTransform(
                        scaleX: CGFloat(w) / e.width, y: CGFloat(h) / e.height)),
                    toBitmap: buf.baseAddress!, rowBytes: w * 16,
                    bounds: CGRect(x: 0, y: 0, width: w, height: h),
                    format: .RGBAf,
                    colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
                )
            }
            var s = 0.0
            for i in 0..<(w * h) { s += Double(px[i * 4 + 1]) }
            return s / Double(w * h)
        }
        let aMean = meanGreen(auto), nMean = meanGreen(neutral)
        XCTAssertLessThan(
            aMean, nMean * 0.95,
            "Auto buffer (AE-Off) must be darker than Neutral (AE-On) — equal means the "
            + "profile param didn't route to a distinct decode / cache served the wrong buffer "
            + "(auto=\(aMean) neutral=\(nMean))."
        )
    }
}
