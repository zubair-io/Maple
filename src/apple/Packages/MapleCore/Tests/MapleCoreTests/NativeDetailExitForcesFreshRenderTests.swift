// NativeDetailExitForcesFreshRenderTests.swift — round-2 fix for #2683: a
// film look changed WHILE zoomed to native-detail (100%) must not surface
// stale once the user zooms back to fit.
//
// Root cause: while `pixelScale >= NativeDetailLOD.minimumPixelScale`,
// `refineBody` (EditSession+RenderScheduling.swift) never calls
// `decodeAndRender` at all — every visible pixel comes from
// `refineNativeDetail`'s CPU-only patch. `decodeAndRender` (and therefore
// `presentViaGpuLive` / `syncFilmLutForPresent`, which push a changed film
// look to the GPU driver) only ran, while zoomed in, because a MODEL EDIT
// happened to trigger a fast-phase render — with no guarantee that present
// actually reached the drawable before the user zoomed back out. Back at
// fit, `refineBody`'s `fast == refine` short-circuit (`fastTargetSize ==
// refinedTargetSize` at `pixelScale == 0`, by design — see
// `CanvasMath.refinedTargetSize`) skips `decodeAndRender` ENTIRELY and just
// persists whatever's already published.
//
// Fix: `EditSession.pixelScale`'s `didSet` now schedules a full fast-phase
// render (`_scheduleRender`, which unconditionally bumps `RenderActor`'s
// generation counter and always reaches `decodeAndRender`) specifically on
// the transition OUT of native-detail range, instead of the cheaper
// `_scheduleRefine()` (which never bumps the generation and, at fit, never
// even calls `decodeAndRender`) every other `pixelScale` change uses.
//
// These tests assert on `renderActor.currentGeneration()` as the render-vs-
// refine seam — `scheduleRender` bumps it unconditionally, `scheduleRefine`
// never does (RenderActor.swift's own doc comments), so a generation bump
// is a reliable, synchronous signal that `_scheduleRender` (not
// `_scheduleRefine`) ran, without needing a live RAW fixture or waiting on
// the actual (fixture-less, therefore failing) decode.

import CoreGraphics
import XCTest
@testable import MapleCore

final class NativeDetailExitForcesFreshRenderTests: XCTestCase {

    @MainActor
    private static func makeSession() -> EditSession {
        let tmp = URL(fileURLWithPath: "/tmp/maple_native_detail_exit_test_\(UUID().uuidString).dng")
        let asset = AssetRef(url: tmp)
        let session = EditSession(asset: asset)
        session.nativeImageSize = CGSize(width: 8000, height: 6000)
        return session
    }

    private static let viewport = CGRect(x: 1000, y: 1000, width: 1000, height: 800)

    /// `_scheduleRender`/`_scheduleRefine` hand off to the actor via an
    /// unstructured `Task { await actor.scheduleRender(...) }` — the
    /// generation bump happens inside that Task, not synchronously on the
    /// call that triggered it (a slider write, a `pixelScale` set). Poll
    /// instead of reading `currentGeneration()` immediately, so the
    /// assertion isn't racing the scheduler's own dispatch.
    private static func waitForGeneration(
        _ session: EditSession,
        toExceed baseline: UInt64,
        timeout: TimeInterval = 2.0
    ) async -> UInt64 {
        let deadline = Date().addingTimeInterval(timeout)
        var current = await session.renderActor.currentGeneration()
        while current <= baseline, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
            current = await session.renderActor.currentGeneration()
        }
        return current
    }

    /// For a "must NOT bump" assertion there's no bump to poll for — wait a
    /// short settle window (generously longer than the sub-millisecond
    /// `scheduleRender`/`scheduleRefine` dispatch takes in practice) and
    /// read once.
    private static func generationAfterSettling(
        _ session: EditSession,
        settleMilliseconds: UInt64 = 100
    ) async -> UInt64 {
        try? await Task.sleep(for: .milliseconds(settleMilliseconds))
        return await session.renderActor.currentGeneration()
    }

    /// The failing-test-at-the-seam the round-2 report asked for: simulate
    /// "present at fit with look A -> model.filmLook = B while zoomed to
    /// 100% -> return to fit" and assert the return-to-fit step forces a
    /// fresh render rather than reusing whatever's cached.
    @MainActor
    func testLeavingNativeDetailZoomBumpsRenderGeneration() async {
        let session = Self.makeSession()

        // Enter native-detail zoom (100%) — matches `refineNativeDetail`'s
        // own gate (`NativeDetailLOD.minimumPixelScale == 1`).
        session.updateTileVisibleRegion(viewport: Self.viewport, zoom: 1.0)
        let genAtNativeDetail = await Self.generationAfterSettling(session)

        // A film-look change made WHILE zoomed in — mirrors picking a
        // different look B in `FilmSection` at 100%. `model`'s own `didSet`
        // always schedules a fast-phase render (bumping generation), in or
        // out of native-detail zoom — that part was never broken; it's what
        // makes the 100% view itself show the new look correctly.
        session.model.filmLook = "test_look_b"
        let genAfterModelChange = await Self.waitForGeneration(session, toExceed: genAtNativeDetail)
        XCTAssertGreaterThan(
            genAfterModelChange, genAtNativeDetail,
            "a model change must always schedule a fresh render"
        )

        // Return to fit. Before the fix this called only `_scheduleRefine()`
        // — no generation bump, and (per `refineBody`'s `fast == refine`
        // short-circuit at `pixelScale == 0`) no `decodeAndRender` call at
        // all — so nothing would force a fresh present reflecting the look
        // B change above; the fit view could keep showing whatever the
        // GPU-live drawable / `renderedPreview` last happened to settle on
        // while zoomed in.
        session.updateTileVisibleRegion(viewport: Self.viewport, zoom: 0)
        let genAfterReturnToFit = await Self.waitForGeneration(session, toExceed: genAfterModelChange)

        XCTAssertGreaterThan(
            genAfterReturnToFit, genAfterModelChange,
            "leaving native-detail zoom must force a full fast-phase render " +
            "(bumping renderGeneration) rather than the cheaper _scheduleRefine() " +
            "every other pixelScale change uses"
        )
    }

    /// Contrast case: panning/zooming WITHIN native-detail range (never
    /// crossing back below `NativeDetailLOD.minimumPixelScale`) must keep
    /// using the cheap `_scheduleRefine()` path — no generation bump. Guards
    /// against an overly-broad fix that forces a full render on every zoom
    /// tick, which would blow the 16ms slider-tick budget.
    @MainActor
    func testZoomingWithinNativeDetailRangeDoesNotBumpGeneration() async {
        let session = Self.makeSession()

        session.updateTileVisibleRegion(viewport: Self.viewport, zoom: 1.0)
        let genBefore = await Self.generationAfterSettling(session)

        session.updateTileVisibleRegion(viewport: Self.viewport, zoom: 2.0)
        let genAfter = await Self.generationAfterSettling(session)

        XCTAssertEqual(
            genAfter, genBefore,
            "zooming within native-detail range must stay on the cheap refine path"
        )
    }

    /// Contrast case: ENTERING native-detail zoom (fit -> 100%) also keeps
    /// using `_scheduleRefine()` — it's specifically the EXIT transition
    /// that needs the guarantee, since entry is already correctly served by
    /// `refineNativeDetail`'s own fresh CPU render every time.
    @MainActor
    func testEnteringNativeDetailZoomDoesNotBumpGeneration() async {
        let session = Self.makeSession()
        let genBefore = await Self.generationAfterSettling(session)

        session.updateTileVisibleRegion(viewport: Self.viewport, zoom: 1.0)
        let genAfter = await Self.generationAfterSettling(session)

        XCTAssertEqual(
            genAfter, genBefore,
            "entering native-detail zoom must stay on the cheap refine path"
        )
    }

    /// A no-op zoom write (same value) must not schedule anything at all —
    /// `pixelScale`'s `didSet` guards on `pixelScale != oldValue` before
    /// reaching either scheduling branch.
    @MainActor
    func testUnchangedPixelScaleDoesNotBumpGeneration() async {
        let session = Self.makeSession()
        session.updateTileVisibleRegion(viewport: Self.viewport, zoom: 1.0)
        let genBefore = await Self.generationAfterSettling(session)

        session.updateTileVisibleRegion(viewport: Self.viewport, zoom: 1.0)
        let genAfter = await Self.generationAfterSettling(session)

        XCTAssertEqual(genAfter, genBefore, "an unchanged pixelScale must not reschedule")
    }
}
