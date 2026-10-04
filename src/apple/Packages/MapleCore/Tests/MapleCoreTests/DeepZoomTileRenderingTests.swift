// DeepZoomTileRenderingTests.swift — Plan 3 (Ticket 06 M4) integration
// tests for the tile FFI, MapleRawHandle wrapper,
// `ImageEditPipeline.decodePreviewTile`, `RawImageCache`, and
// `EditSession.computeVisibleSourceRect` + `updateTileVisibleRegion`.
// (The 512²-grid `TileManager` compositor and its tests were retired
// in #3288 — native detail is the 100% path; the tile FFI this file
// covers is what native detail renders through.)
//
// Cross-links:
//   .archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md Task 4
//   .archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md Task 8
//
// Tests are split into two tiers:
//   - "no fixture" tier: exercises the wrapper APIs through their
//     null-pointer / empty-bytes error paths. These run in any
//     environment, including CI without the gitignored DNG fixtures.
//   - "fixture" tier: gated on `test-fixtures/raws/test_0002.dng`. When
//     absent, `XCTSkip` is thrown so the suite still passes overall.
//
// MANUAL SMOKE TEST (deep zoom end-to-end — Task 8):
//
//   Build: `xcodebuild -project src/apple/Maple.xcodeproj -scheme Maple
//          -destination 'platform=macOS' build`
//   Launch the resulting Maple.app and open any RAW (the reference
//   100 MP DNG at test-fixtures/raws/dji-mavic3pro-100mp.dng works
//   well — its detail makes patch boundaries obvious).
//
//   1. The image opens at fit zoom. Indicator shows e.g. "18%".
//      EditSession.pixelScale is 0; the native-detail branch is OFF.
//
//   2. Press ⌘1. pixelScale jumps to 1.0; the indicator shows "100%".
//      `_scheduleRefine` debounces 150 ms then renders the
//      native-detail patch. The sized preview shows through while
//      the patch develops. Within ~500 ms the viewport should pop
//      sharp (sharper edges, no resampling artifacts).
//
//   3. Drag-pan with two fingers (or click-drag). On `.onEnded`
//      the new viewport rect is pushed; small pans land inside the
//      already-published patch (#2063 containment) and need no
//      re-render, larger pans develop a fresh patch.
//
//   Watch for: NO stutter on slider ticks (fit-mode budget is 16 ms).
//   NO blank canvas — the sized preview underlay must always be
//   visible while the patch develops.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

final class DeepZoomTileRenderingTests: XCTestCase {

    // MARK: - Fixture lookup helper

    /// Resolve the gitignored test_0002.dng fixture by walking up from
    /// the test source file to the repository root, then into
    /// `test-fixtures/raws/`. Returns nil if absent.
    private func fixtureURL() -> URL? {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // MapleCore/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
            .appendingPathComponent("test-fixtures/raws/test_0002.dng")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    // MARK: - openRawHandle / renderTile error paths (no fixture needed)

    /// `openRawHandle` on a non-existent file throws renderFailed.
    func testOpenRawHandleNonExistentFileThrows() {
        let bogus = URL(fileURLWithPath: "/tmp/does_not_exist_maple_tile_test.dng")
        XCTAssertThrowsError(try PipelineRenderer.openRawHandle(rawPath: bogus)) { err in
            guard let pe = err as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(err)")
                return
            }
            // rc 6 = RAW read failed (file not found path).
            XCTAssertNotEqual(code, 0)
        }
    }

    /// One-shot `renderTile(rawPath:...)` on a non-existent file throws
    /// renderFailed.
    func testRenderTileFromFileNonExistentThrows() {
        let bogus = URL(fileURLWithPath: "/tmp/does_not_exist_maple_tile_test.dng")
        XCTAssertThrowsError(try PipelineRenderer.renderTile(
            rawPath: bogus,
            srcX: 0, srcY: 0, srcW: 256, srcH: 256,
            outW: 128, outH: 128
        )) { err in
            guard let pe = err as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(err)")
                return
            }
            XCTAssertNotEqual(code, 0)
        }
    }

    /// One-shot `renderTile(rawBytes:...)` with empty bytes throws
    /// renderFailed (rawler can't decode an empty byte slice).
    func testRenderTileFromEmptyBytesThrows() {
        XCTAssertThrowsError(try PipelineRenderer.renderTile(
            rawBytes: Data(),
            hint: "dng",
            srcX: 0, srcY: 0, srcW: 256, srcH: 256,
            outW: 128, outH: 128
        )) { err in
            guard let pe = err as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(err)")
                return
            }
            XCTAssertNotEqual(code, 0)
        }
    }

    // MARK: - Fixture-gated round-trip lifecycle

    /// Open a handle, render a single tile, and let the deinit close it.
    /// Verifies the wrapper's full lifecycle plus the FFI buffer shape.
    /// Skipped if the test fixture isn't present.
    func testRawHandleRoundTripRendersTile() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let handle = try PipelineRenderer.openRawHandle(rawPath: url, xmpPath: nil)
        let tile = try PipelineRenderer.renderTile(
            handle: handle,
            srcX: 1024, srcY: 1024,
            srcW: 512, srcH: 512,
            outW: 256, outH: 256,
            quality: .full
        )
        XCTAssertEqual(tile.width, 256)
        XCTAssertEqual(tile.height, 256)
        XCTAssertEqual(tile.bytesPerPixel, 8)
        XCTAssertEqual(tile.channels, 4)
        XCTAssertEqual(tile.pixels.count, 256 * 256 * 8)
        // `handle` deinits at scope exit → maple_close_raw_handle.
    }

    /// Open once, render N tiles against the same handle. Validates
    /// that the cached decoded mosaic is reusable across multiple tile
    /// fetches without crashing or drifting in shape.
    func testRawHandleRendersMultipleTiles() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let handle = try PipelineRenderer.openRawHandle(rawPath: url)
        let coords: [(UInt32, UInt32)] = [(0, 0), (1024, 0), (0, 1024)]
        for (sx, sy) in coords {
            let tile = try PipelineRenderer.renderTile(
                handle: handle,
                srcX: sx, srcY: sy,
                srcW: 512, srcH: 512,
                outW: 256, outH: 256
            )
            XCTAssertEqual(tile.width, 256, "tile (\(sx),\(sy)) width")
            XCTAssertEqual(tile.height, 256, "tile (\(sx),\(sy)) height")
            XCTAssertEqual(tile.pixels.count, 256 * 256 * 8)
        }
    }

    /// One-shot `renderTile(rawPath:...)` succeeds without an explicit
    /// handle. Same shape checks as the handle-based path.
    func testRenderTileFromFileRoundTrip() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let tile = try PipelineRenderer.renderTile(
            rawPath: url,
            srcX: 1024, srcY: 1024,
            srcW: 512, srcH: 512,
            outW: 256, outH: 256
        )
        XCTAssertEqual(tile.width, 256)
        XCTAssertEqual(tile.height, 256)
    }

    /// `renderTile` rejects upscale (out > src) — surfaces the FFI rc=11.
    func testRenderTileRejectsUpscale() throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let handle = try PipelineRenderer.openRawHandle(rawPath: url)
        XCTAssertThrowsError(try PipelineRenderer.renderTile(
            handle: handle,
            srcX: 1024, srcY: 1024,
            srcW: 256, srcH: 256,
            outW: 512, outH: 512  // > src → rc=11
        )) { err in
            guard let pe = err as? PipelineError,
                  case .renderFailed(let code, _) = pe else {
                XCTFail("Expected PipelineError.renderFailed, got \(err)")
                return
            }
            XCTAssertEqual(code, 11, "expected upscale rc=11, got \(code)")
        }
    }

    /// `decodePreviewTile` returns a CIImage tagged
    /// extendedLinearITUR_2020 at the requested output dimensions.
    func testDecodePreviewTileReturnsTaggedRec2020CIImage() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let asset = AssetRef(url: url)
        let pipeline = ImageEditPipeline()
        let tile = await pipeline.decodePreviewTile(
            asset: asset,
            srcRect: CGRect(x: 1024, y: 1024, width: 512, height: 512),
            outSize: CGSize(width: 256, height: 256),
            quality: .full
        )
        let img = try XCTUnwrap(tile)
        XCTAssertEqual(Int(img.extent.size.width), 256)
        XCTAssertEqual(Int(img.extent.size.height), 256)
        // CIImage.colorSpace returns Optional<CGColorSpace>; check name.
        XCTAssertEqual(
            img.colorSpace?.name as String?,
            CGColorSpace.extendedLinearITUR_2020 as String,
            "decodePreviewTile must tag extendedLinearITUR_2020"
        )
    }

    // MARK: - Task 5: RawImageCache

    /// Resolve a secondary fixture, used to test that switching assets
    /// evicts the cached entry. Walks the same 7 levels as
    /// `fixtureURL()` to land on the repo root.
    private func secondaryFixtureURL() -> URL? {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // MapleCore/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
            .appendingPathComponent("test-fixtures/raws/test_0006.DNG")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Cache hit: opening the same URL twice returns the SAME handle
    /// instance (`===`). Validates that the second call skipped the
    /// rawler decode.
    func testRawImageCacheReturnsSameHandleAcrossCalls() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let cache = RawImageCache()
        let h1 = try await cache.handle(for: url)
        let h2 = try await cache.handle(for: url)
        XCTAssertTrue(h1 === h2, "second call must reuse cached handle")
    }

    /// Switching to a different URL evicts the previous entry; refetching
    /// the original URL produces a NEW handle instance (different `===`).
    func testRawImageCacheEvictsOnAssetSwitch() async throws {
        guard let u1 = fixtureURL(), let u2 = secondaryFixtureURL() else {
            throw XCTSkip("required fixtures not present; skipping")
        }
        let cache = RawImageCache()
        let h1 = try await cache.handle(for: u1)
        let h2 = try await cache.handle(for: u2)
        let h1Again = try await cache.handle(for: u1)
        XCTAssertFalse(h1 === h1Again, "switching to u2 should evict u1; refetch decodes again")
        XCTAssertFalse(h1 === h2, "h1 and h2 are different assets")
    }

    /// Explicit `evict()` drops the cached entry; the next call decodes
    /// again.
    func testRawImageCacheExplicitEvict() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let cache = RawImageCache()
        let h1 = try await cache.handle(for: url)
        await cache.evict()
        let cached = await cache.cachedURL
        XCTAssertNil(cached, "evict() must clear the cached URL")
        let h2 = try await cache.handle(for: url)
        XCTAssertFalse(h1 === h2, "post-evict refetch must decode a fresh handle")
    }

    /// `cachedURL` reports the asset currently held — used by tests and
    /// instrumentation to verify cache state without poking internals.
    func testRawImageCacheCachedURLReflectsCurrentEntry() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("test_0002.dng fixture not present; skipping")
        }
        let cache = RawImageCache()
        let beforeOpen = await cache.cachedURL
        XCTAssertNil(beforeOpen)
        _ = try await cache.handle(for: url)
        let afterOpen = await cache.cachedURL
        XCTAssertEqual(afterOpen, url)
    }

    /// Bogus path surfaces the FFI error; the cache stays empty.
    func testRawImageCacheNonExistentFileThrows() async {
        let bogus = URL(fileURLWithPath: "/tmp/does_not_exist_maple_cache_test.dng")
        let cache = RawImageCache()
        do {
            _ = try await cache.handle(for: bogus)
            XCTFail("expected an error from a non-existent file")
        } catch {
            // expected — RAW decode fails
        }
        let cached = await cache.cachedURL
        XCTAssertNil(cached, "failed open must NOT populate the cache")
    }

    // MARK: - Task 8: EditSession.computeVisibleSourceRect (pure math)

    /// Centred viewport at zoom 1.0 returns a rect centred on the image
    /// with viewport-pixel-sized extent. Sanity check for the core math.
    func testComputeVisibleSourceRectAtZoom1Centered() {
        let rect = EditSession.computeVisibleSourceRect(
            viewport: CGSize(width: 1000, height: 800),
            zoom: 1.0,
            imageSize: CGSize(width: 4000, height: 3000),
            panOffset: .zero,
            displayScale: 2.0
        )
        // viewportPx = 2000×1600, visibleSrc = 2000×1600, centred on (2000,1500)
        // → minX = 1000, minY = 700.
        XCTAssertEqual(rect.origin.x, 1000, accuracy: 0.01)
        XCTAssertEqual(rect.origin.y, 700, accuracy: 0.01)
        XCTAssertEqual(rect.size.width, 2000, accuracy: 0.01)
        XCTAssertEqual(rect.size.height, 1600, accuracy: 0.01)
    }

    /// Zoom 2.0 halves the visible source-pixel extent compared to 1.0.
    func testComputeVisibleSourceRectAtZoom2HalvesExtent() {
        let rect = EditSession.computeVisibleSourceRect(
            viewport: CGSize(width: 1000, height: 800),
            zoom: 2.0,
            imageSize: CGSize(width: 4000, height: 3000),
            panOffset: .zero,
            displayScale: 2.0
        )
        // visibleSrc = 1000×800, centred → minX=1500, minY=1100.
        XCTAssertEqual(rect.origin.x, 1500, accuracy: 0.01)
        XCTAssertEqual(rect.origin.y, 1100, accuracy: 0.01)
        XCTAssertEqual(rect.size.width, 1000, accuracy: 0.01)
        XCTAssertEqual(rect.size.height, 800, accuracy: 0.01)
    }

    /// A non-zero pan offset shifts the visible rect away from centre
    /// in the OPPOSITE direction (rightward drag exposes the left side
    /// of the source image, so the rect's minX decreases).
    func testComputeVisibleSourceRectShiftsForPanOffset() {
        let rect = EditSession.computeVisibleSourceRect(
            viewport: CGSize(width: 1000, height: 800),
            zoom: 2.0,
            imageSize: CGSize(width: 4000, height: 3000),
            panOffset: CGSize(width: 100, height: 50),
            displayScale: 2.0
        )
        // panSrcX = 100*2/2 = 100. centerX = 2000-100 = 1900.
        // minX = 1900 - 500 = 1400. Same logic for y.
        XCTAssertEqual(rect.origin.x, 1400, accuracy: 0.01)
        XCTAssertEqual(rect.origin.y, 1050, accuracy: 0.01)
        XCTAssertEqual(rect.size.width, 1000, accuracy: 0.01)
        XCTAssertEqual(rect.size.height, 800, accuracy: 0.01)
    }

    /// Fit mode (zoom == 0) and unset image extent both return .zero so
    /// EditSession's deep-zoom branch is disabled.
    func testComputeVisibleSourceRectReturnsZeroForFitMode() {
        let rect = EditSession.computeVisibleSourceRect(
            viewport: CGSize(width: 1000, height: 800),
            zoom: 0.0,
            imageSize: CGSize(width: 4000, height: 3000),
            panOffset: .zero,
            displayScale: 2.0
        )
        XCTAssertEqual(rect, .zero)
    }

    func testComputeVisibleSourceRectReturnsZeroForUnsetImageSize() {
        let rect = EditSession.computeVisibleSourceRect(
            viewport: CGSize(width: 1000, height: 800),
            zoom: 1.0,
            imageSize: nil,
            panOffset: .zero,
            displayScale: 2.0
        )
        XCTAssertEqual(rect, .zero)
    }

    /// When the visible region is larger than the image (heavy zoom-out
    /// of a small image), the rect clamps to the image extent so we
    /// never ask for off-grid tiles.
    func testComputeVisibleSourceRectClampsToImageBounds() {
        let rect = EditSession.computeVisibleSourceRect(
            viewport: CGSize(width: 4000, height: 3000),
            zoom: 1.0,
            imageSize: CGSize(width: 1000, height: 800),
            panOffset: .zero,
            displayScale: 1.0
        )
        XCTAssertEqual(rect.origin.x, 0, accuracy: 0.01)
        XCTAssertEqual(rect.origin.y, 0, accuracy: 0.01)
        XCTAssertEqual(rect.size.width, 1000, accuracy: 0.01)
        XCTAssertEqual(rect.size.height, 800, accuracy: 0.01)
    }

    /// Different display scales scale the source-pixel extent inversely:
    /// a Retina (displayScale 2) display sees TWICE as many source
    /// pixels as a 1× display at the same zoom + viewport size.
    func testComputeVisibleSourceRectRespectsDisplayScale() {
        let r1 = EditSession.computeVisibleSourceRect(
            viewport: CGSize(width: 500, height: 500),
            zoom: 1.0,
            imageSize: CGSize(width: 4000, height: 4000),
            panOffset: .zero,
            displayScale: 1.0
        )
        let r2 = EditSession.computeVisibleSourceRect(
            viewport: CGSize(width: 500, height: 500),
            zoom: 1.0,
            imageSize: CGSize(width: 4000, height: 4000),
            panOffset: .zero,
            displayScale: 2.0
        )
        // r1 sees 500 src-px wide; r2 sees 1000.
        XCTAssertEqual(r1.size.width, 500, accuracy: 0.01)
        XCTAssertEqual(r2.size.width, 1000, accuracy: 0.01)
    }

    // MARK: - Task 8: EditSession deep-zoom wiring

    /// `updateTileVisibleRegion` writes through to `viewportSourceRect`
    /// and `pixelScale`. Smoke test for the public API EditSession
    /// exposes to `CanvasZoomController`.
    @MainActor
    func testEditSessionUpdateTileVisibleRegionPersists() {
        let tmp = URL(fileURLWithPath: "/tmp/maple_session_smoke.dng")
        let asset = AssetRef(url: tmp)
        let session = EditSession(asset: asset)
        let rect = CGRect(x: 100, y: 200, width: 1000, height: 800)
        session.updateTileVisibleRegion(viewport: rect, zoom: 1.5)
        XCTAssertEqual(session.viewportSourceRect, rect)
        XCTAssertEqual(session.pixelScale, 1.5, accuracy: 0.001)
    }

    /// `updateTileVisibleRegion(zoom: 0)` with an empty rect leaves
    /// pixelScale at 0 (fit mode) and the rect at zero — disabling
    /// the deep-zoom branch.
    @MainActor
    func testEditSessionUpdateTileVisibleRegionFitMode() {
        let tmp = URL(fileURLWithPath: "/tmp/maple_session_fit.dng")
        let asset = AssetRef(url: tmp)
        let session = EditSession(asset: asset)
        session.updateTileVisibleRegion(viewport: .zero, zoom: 0)
        XCTAssertEqual(session.viewportSourceRect, .zero)
        XCTAssertEqual(session.pixelScale, 0, accuracy: 0.001)
    }

    // MARK: - #2063 pan-reuse containment fast path

    /// A small pan whose new detail rect stays inside the previously
    /// published native-detail patch must NOT clear `nativeDetailPreview` —
    /// this is the whole point of the containment fast path: the overlay
    /// stays on screen instead of dropping to the blurry base while a
    /// fresh 150ms-debounced develop runs for a pan that didn't need one.
    @MainActor
    func testEditSessionUpdateTileVisibleRegionKeepsContainedNativeDetailPreview() {
        let tmp = URL(fileURLWithPath: "/tmp/maple_session_pan_reuse.dng")
        let asset = AssetRef(url: tmp)
        let session = EditSession(asset: asset)
        session.nativeImageSize = CGSize(width: 8000, height: 6000)
        session.updateTileVisibleRegion(
            viewport: CGRect(x: 1000, y: 1000, width: 1000, height: 800),
            zoom: 1.0
        )
        // Simulate a previously-published native-detail patch — bigger
        // than the viewport, as `NativeDetailLOD.patchRect` would produce.
        session.nativeDetailPreview = Self.makeTinyCIImage()
        session.nativeDetailSourceRect = CGRect(x: 800, y: 800, width: 1400, height: 1200)

        // Small pan (50px right, 30px down) whose new detail rect stays
        // inside the published patch.
        session.updateTileVisibleRegion(
            viewport: CGRect(x: 1050, y: 1030, width: 1000, height: 800),
            zoom: 1.0
        )

        XCTAssertNotNil(session.nativeDetailPreview, "a contained pan must keep the overlay")
        XCTAssertEqual(
            session.nativeDetailSourceRect,
            CGRect(x: 800, y: 800, width: 1400, height: 1200),
            "the published patch must be untouched by a contained pan"
        )
    }

    /// A pan whose new detail rect escapes the published patch must still
    /// clear the overlay — existing behaviour, unaffected by the
    /// containment fast path.
    @MainActor
    func testEditSessionUpdateTileVisibleRegionClearsWhenPanEscapesPatch() {
        let tmp = URL(fileURLWithPath: "/tmp/maple_session_pan_escape.dng")
        let asset = AssetRef(url: tmp)
        let session = EditSession(asset: asset)
        session.nativeImageSize = CGSize(width: 8000, height: 6000)
        session.updateTileVisibleRegion(
            viewport: CGRect(x: 1000, y: 1000, width: 1000, height: 800),
            zoom: 1.0
        )
        session.nativeDetailPreview = Self.makeTinyCIImage()
        session.nativeDetailSourceRect = CGRect(x: 800, y: 800, width: 1400, height: 1200)

        // Large pan (2000px right) whose new detail rect is NOT inside
        // the published patch.
        session.updateTileVisibleRegion(
            viewport: CGRect(x: 3000, y: 3000, width: 1000, height: 800),
            zoom: 1.0
        )

        XCTAssertNil(session.nativeDetailPreview, "a pan outside the patch must clear the overlay")
        XCTAssertEqual(session.nativeDetailSourceRect, .zero)
    }

    /// A zoom change must still clear the overlay even though the rect
    /// itself didn't move — zoom changes invalidate the native-detail
    /// patch regardless of containment (native detail is resolution-
    /// dependent), via `pixelScale`'s own `didSet`.
    @MainActor
    func testEditSessionUpdateTileVisibleRegionClearsOnZoomChangeEvenIfRectUnchanged() {
        let tmp = URL(fileURLWithPath: "/tmp/maple_session_zoom_change.dng")
        let asset = AssetRef(url: tmp)
        let session = EditSession(asset: asset)
        session.nativeImageSize = CGSize(width: 8000, height: 6000)
        let viewport = CGRect(x: 1000, y: 1000, width: 1000, height: 800)
        session.updateTileVisibleRegion(viewport: viewport, zoom: 1.0)
        session.nativeDetailPreview = Self.makeTinyCIImage()
        session.nativeDetailSourceRect = CGRect(x: 800, y: 800, width: 1400, height: 1200)

        // Same viewport rect, but zoom changed.
        session.updateTileVisibleRegion(viewport: viewport, zoom: 2.0)

        XCTAssertNil(session.nativeDetailPreview, "a zoom change must clear the overlay")
    }

    /// Without a previously-published patch (`nativeDetailPreview == nil`),
    /// a pan must still clear (a no-op — it's already nil) and reach the
    /// refine-scheduling branch; this guards against the containment
    /// check accidentally treating "no patch yet" as "covered."
    @MainActor
    func testEditSessionUpdateTileVisibleRegionWithNoPublishedPatchIsUnaffected() {
        let tmp = URL(fileURLWithPath: "/tmp/maple_session_no_patch.dng")
        let asset = AssetRef(url: tmp)
        let session = EditSession(asset: asset)
        session.nativeImageSize = CGSize(width: 8000, height: 6000)
        session.updateTileVisibleRegion(
            viewport: CGRect(x: 1000, y: 1000, width: 1000, height: 800),
            zoom: 1.0
        )
        XCTAssertNil(session.nativeDetailPreview)

        session.updateTileVisibleRegion(
            viewport: CGRect(x: 1050, y: 1030, width: 1000, height: 800),
            zoom: 1.0
        )
        XCTAssertNil(session.nativeDetailPreview)
        XCTAssertEqual(session.viewportSourceRect, CGRect(x: 1050, y: 1030, width: 1000, height: 800))
    }

    /// Tiny CIImage for cache accounting tests — synthetic, no decode.
    static func makeTinyCIImage() -> CIImage {
        let side = 8
        let bytes = Data(count: side * side * 8)
        return CIImage(
            bitmapData: bytes, bytesPerRow: side * 8,
            size: CGSize(width: side, height: side),
            format: .RGBAh,
            colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        )
    }
}
