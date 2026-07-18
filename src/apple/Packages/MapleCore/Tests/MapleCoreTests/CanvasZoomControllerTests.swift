// CanvasZoomControllerTests.swift — #1099 (spec §5.0).
//
// Covers the EditSession plumbing layer over `CanvasZoomModel`: the
// viewport → `previewSize` / resolved `pixelScale` sync, the
// commit-on-gesture-END contract (mid-pinch frames must not retarget
// the session), the visible-rect push on commit, and the asset-change
// reset. MainActor — EditSession + the controller are MainActor-
// isolated. Sessions come from `EditSession.preview()` (no real asset →
// no rendering side effects), same pattern as EditorStateTests.

import XCTest
import CoreGraphics
@testable import MapleCore

@MainActor
final class CanvasZoomControllerTests: XCTestCase {

    /// Preview session with a seeded native size (8000×6000) so fit math
    /// resolves: 1000×800pt viewport @2× → viewportPx 2000×1600,
    /// fit = 0.25.
    private func makeController() -> CanvasZoomController {
        let session = EditSession.preview()
        session.nativeImageSize = CGSize(width: 8000, height: 6000)
        let controller = CanvasZoomController(session: session)
        controller.viewportChanged(points: CGSize(width: 1000, height: 800), displayScale: 2)
        return controller
    }

    // MARK: - Viewport plumbing

    func testViewportChangedPushesPreviewSizeAndResolvedScale() {
        let controller = makeController()
        XCTAssertEqual(controller.session.previewSize, CGSize(width: 2000, height: 1600))
        // Fit resolves to a concrete value on the session (never the 0
        // sentinel — the session treats pixelScale as resolved).
        XCTAssertEqual(controller.session.pixelScale, 0.25, accuracy: 1e-9)
        XCTAssertEqual(controller.effectivePixelScale, 0.25, accuracy: 1e-9)
    }

    func testViewportChangedIgnoresDegenerateSizes() {
        let controller = makeController()
        controller.viewportChanged(points: .zero, displayScale: 2)
        XCTAssertEqual(controller.session.previewSize, CGSize(width: 2000, height: 1600),
                       "a zero viewport must not clobber the live target")
    }

    func testDisplayFrameResolvesFitRect() {
        let controller = makeController()
        XCTAssertEqual(controller.displayFrameInPoints, CGSize(width: 1000, height: 750))
    }

    func testNativeImageSizeChangedResolvesNewFit() {
        let controller = makeController()
        // Metadata seed corrects the native size — fit re-resolves.
        controller.session.nativeImageSize = CGSize(width: 4000, height: 3000)
        controller.nativeImageSizeChanged()
        XCTAssertEqual(controller.session.pixelScale, 0.5, accuracy: 1e-9)
    }

    func testViewportResizeRepushesVisibleRect() {
        let controller = makeController()
        controller.zoomToScale(1.0)
        XCTAssertEqual(controller.session.viewportSourceRect.width, 2000, accuracy: 1e-6)
        XCTAssertEqual(controller.session.viewportSourceRect.height, 1600, accuracy: 1e-6)
        // Window grows — same zoom, more source pixels visible. The
        // visible rect must follow the new viewport, not stay stale
        // (#1125 review).
        controller.viewportChanged(points: CGSize(width: 1200, height: 900), displayScale: 2)
        let rect = controller.session.viewportSourceRect
        XCTAssertEqual(rect.width, 2400, accuracy: 1e-6)
        XCTAssertEqual(rect.height, 1800, accuracy: 1e-6)
        XCTAssertEqual(rect.midX, 4000, accuracy: 1e-6, "still centered (no pan)")
        XCTAssertEqual(controller.session.pixelScale, 1.0, accuracy: 1e-9,
                       "a resize never changes the zoom")
    }

    func testNativeImageSizeChangedRepushesVisibleRect() {
        let controller = makeController()
        // Fit mode pushed the full pre-seed extent on mount.
        XCTAssertEqual(controller.session.viewportSourceRect.width, 8000, accuracy: 1e-6)
        XCTAssertEqual(controller.session.viewportSourceRect.height, 6000, accuracy: 1e-6)
        // Metadata seed corrects the native size — the visible rect must
        // re-resolve against the new extent (#1125 review).
        controller.session.nativeImageSize = CGSize(width: 4000, height: 3000)
        controller.nativeImageSizeChanged()
        let rect = controller.session.viewportSourceRect
        XCTAssertEqual(rect.origin, .zero)
        XCTAssertEqual(rect.width, 4000, accuracy: 1e-6)
        XCTAssertEqual(rect.height, 3000, accuracy: 1e-6)
    }

    // MARK: - Commit-on-end contract

    func testPinchFramesDoNotRetargetSessionUntilEnd() {
        let controller = makeController()
        controller.pinchChanged(magnification: 4.0, location: CGPoint(x: 500, y: 400))
        XCTAssertEqual(controller.model.pixelScale, 1.0, accuracy: 1e-9,
                       "live model scale moves per frame")
        XCTAssertEqual(controller.session.pixelScale, 0.25, accuracy: 1e-9,
                       "session retargets only on gesture end")

        controller.pinchEnded(magnification: 4.0)
        XCTAssertEqual(controller.session.pixelScale, 1.0, accuracy: 1e-9)
    }

    func testPinchEndPushesVisibleSourceRect() {
        let controller = makeController()
        // Center-anchored pinch fit → 100%.
        controller.pinchChanged(magnification: 4.0, location: CGPoint(x: 500, y: 400))
        controller.pinchEnded(magnification: 4.0)
        // 100%: 2000×1600 viewport px over an 8000×6000 image, centered.
        let rect = controller.session.viewportSourceRect
        XCTAssertEqual(rect.width, 2000, accuracy: 1e-6)
        XCTAssertEqual(rect.height, 1600, accuracy: 1e-6)
        XCTAssertEqual(rect.midX, 4000, accuracy: 1e-6)
        XCTAssertEqual(rect.midY, 3000, accuracy: 1e-6)
    }

    func testDragCommitsVisibleRectOnEndOnly() {
        let controller = makeController()
        controller.zoomToScale(1.0)
        let rectBefore = controller.session.viewportSourceRect
        controller.dragChanged(translation: CGSize(width: -500, height: 0))
        XCTAssertEqual(controller.session.viewportSourceRect, rectBefore,
                       "mid-drag frames stay off the session")
        controller.dragEnded()
        // Image dragged left 500pt → 1000 source px → window shifts right.
        XCTAssertEqual(controller.session.viewportSourceRect.midX, 5000, accuracy: 1e-6)
    }

    func testDragAtFitNeverTouchesTheSession() {
        let controller = makeController()
        let rectBefore = controller.session.viewportSourceRect
        let scaleBefore = controller.session.pixelScale
        controller.dragChanged(translation: CGSize(width: 300, height: 300))
        controller.dragEnded()
        XCTAssertEqual(controller.session.viewportSourceRect, rectBefore)
        XCTAssertEqual(controller.session.pixelScale, scaleBefore)
        XCTAssertEqual(controller.panOffset, .zero)
    }

    // MARK: - Commands

    func testZoomCommandsRetargetSessionImmediately() {
        let controller = makeController()
        controller.zoomToScale(1.0)
        XCTAssertEqual(controller.session.pixelScale, 1.0, accuracy: 1e-9)

        controller.stepZoomIn()
        XCTAssertEqual(controller.session.pixelScale, 1.25, accuracy: 1e-9)

        controller.resetToFit()
        XCTAssertEqual(controller.session.pixelScale, 0.25, accuracy: 1e-9,
                       "fit commits the RESOLVED scale, not the 0 sentinel")
        XCTAssertFalse(controller.isZoomedIn)
    }

    func testDoubleTapToggleCommitsBothDirections() {
        let controller = makeController()
        controller.doubleTap(at: CGPoint(x: 500, y: 400), behavior: .toggleFitAnd100)
        XCTAssertEqual(controller.session.pixelScale, 1.0, accuracy: 1e-9)
        controller.doubleTap(at: CGPoint(x: 500, y: 400), behavior: .toggleFitAnd100)
        XCTAssertEqual(controller.session.pixelScale, 0.25, accuracy: 1e-9)
    }

    func testWheelZoomCommitsImmediately() {
        let controller = makeController()
        controller.wheelZoom(normalizedDeltaY: 200, location: CGPoint(x: 500, y: 400))
        XCTAssertGreaterThan(controller.session.pixelScale, 0.25)
        XCTAssertEqual(controller.session.pixelScale, controller.effectivePixelScale,
                       accuracy: 1e-9)
    }

    // MARK: - Wheel-pan commit coalescing (#2036)

    /// Rapid wheel-pan events (trackpad two-finger scroll firing dozens of
    /// times/sec) must move the live model on every event but defer the
    /// session commit — a synchronous per-event commit used to clear the
    /// native-detail overlay and reschedule a refine Task on every single
    /// event. This test body never suspends, so the main-actor debounce
    /// task cannot interleave regardless of interval; the deliberately
    /// huge injected interval makes the "no commit during the stream"
    /// assertion robust against scheduler jitter on any runner.
    func testWheelPanEventsUpdateModelLiveWithoutCommitting() {
        let controller = makeController()
        controller.zoomToScale(1.0)
        controller._testSetWheelPanCommitInterval(milliseconds: 10_000)
        let rectAfterZoom = controller.session.viewportSourceRect

        for _ in 0..<10 {
            controller.wheelPan(delta: CGSize(width: -10, height: 0))
        }

        XCTAssertNotEqual(controller.model.panOffset, .zero,
                           "the live model must move on every event")
        XCTAssertEqual(controller.session.viewportSourceRect, rectAfterZoom,
                       "no commit reaches the session while the wheel stream is still active")
        XCTAssertEqual(controller._testWheelPanCommitFireCount, 0)
    }

    /// After the wheel stream goes idle, exactly one commit fires and it
    /// reflects the FINAL model state — not an intermediate one. The wait
    /// (250 ms) is ~8× the injected debounce (30 ms) so CI scheduler
    /// jitter can't stall the commit past the assertion.
    func testWheelPanCommitsOnceAfterStreamGoesIdle() async {
        let controller = makeController()
        controller.zoomToScale(1.0)
        controller._testSetWheelPanCommitInterval(milliseconds: 30)

        for _ in 0..<10 {
            controller.wheelPan(delta: CGSize(width: -10, height: 0))
        }
        let panAtLastEvent = controller.model.panOffset

        try? await Task.sleep(for: .milliseconds(250))

        XCTAssertEqual(controller._testWheelPanCommitFireCount, 1,
                       "ten rapid events must coalesce into exactly one commit")
        XCTAssertEqual(controller.panOffset, panAtLastEvent,
                       "the single commit reflects the tail of the stream")
        // 10 events × −10 pt = −100 pt of pan → 200 source px (2× display
        // scale): the committed window shifts right from the centered 4000
        // to exactly 4200. An intermediate commit would land short of it.
        XCTAssertEqual(controller.session.viewportSourceRect.midX, 4200, accuracy: 1e-6,
                       "the committed visible rect reflects the FINAL panned position")
    }

    /// A fresh wheel event that arrives before the debounce fires must
    /// cancel and restart the wait — this is what makes momentum-scroll
    /// tails (which just extend the event stream) work correctly instead
    /// of committing mid-stream. Margins are wide (150 ms debounce, 60 ms
    /// sleeps) so scheduler jitter on a loaded CI runner can't let the
    /// first deadline fire before the second event re-arms it.
    func testFreshWheelEventRestartsTheDebounce() async {
        let controller = makeController()
        controller.zoomToScale(1.0)
        controller._testSetWheelPanCommitInterval(milliseconds: 150)

        controller.wheelPan(delta: CGSize(width: -10, height: 0))
        try? await Task.sleep(for: .milliseconds(60))
        // Re-arm well before the first commit would have fired (at 150 ms).
        // If the second event failed to cancel + restart the wait, the
        // ORIGINAL 150 ms deadline would fire during the next sleep.
        controller.wheelPan(delta: CGSize(width: -10, height: 0))
        try? await Task.sleep(for: .milliseconds(60))

        XCTAssertEqual(controller._testWheelPanCommitFireCount, 0,
                       "the second event must have cancelled + restarted the debounce")

        try? await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(controller._testWheelPanCommitFireCount, 1,
                       "the restarted debounce eventually fires exactly once")
    }

    // MARK: - Early commands (no viewport yet)

    func testZoomCommandBeforeViewportDefersCommit() {
        // Early toolbar shortcut: ⌘1 can fire before the host reports a
        // viewport. CanvasMath resolves fit against the degenerate
        // viewport as 1, so committing would write a wrong
        // `session.pixelScale` and schedule refines against the wrong
        // target (#1125 review). The model queues the intent; the commit
        // flushes when the real viewport arrives.
        let session = EditSession.preview()
        session.nativeImageSize = CGSize(width: 8000, height: 6000)
        let controller = CanvasZoomController(session: session)

        controller.zoomToScale(1.0)
        controller.stepZoomIn()
        XCTAssertEqual(session.pixelScale, 0,
                       "no session write against a degenerate viewport")
        XCTAssertEqual(session.viewportSourceRect, .zero)
        XCTAssertEqual(controller.model.pixelScale, 1.25, accuracy: 1e-9,
                       "the model holds the queued intent")

        controller.viewportChanged(points: CGSize(width: 1000, height: 800), displayScale: 2)
        XCTAssertEqual(session.pixelScale, 1.25, accuracy: 1e-9,
                       "the deferred commit flushes with the real viewport")
        XCTAssertEqual(session.viewportSourceRect.width, 1600, accuracy: 1e-6)
        XCTAssertEqual(session.viewportSourceRect.height, 1280, accuracy: 1e-6)
    }

    func testResetToFitBeforeViewportLeavesSessionUntouched() {
        let session = EditSession.preview()
        session.nativeImageSize = CGSize(width: 8000, height: 6000)
        let controller = CanvasZoomController(session: session)

        controller.resetToFit()
        XCTAssertEqual(session.pixelScale, 0)
        XCTAssertEqual(session.previewSize, .zero)
        XCTAssertEqual(session.viewportSourceRect, .zero)
    }

    // MARK: - Asset change

    func testAssetChangedResetsToFitAndResyncs() {
        let controller = makeController()
        controller.zoomToScale(4.0)
        controller.assetChanged()
        XCTAssertFalse(controller.isZoomedIn)
        XCTAssertEqual(controller.panOffset, .zero)
        XCTAssertEqual(controller.session.pixelScale, 0.25, accuracy: 1e-9)
        XCTAssertEqual(controller.session.previewSize, CGSize(width: 2000, height: 1600))
    }

    // MARK: - Live pinch transform (#1493)

    func testGestureTransformLivePanIsClampedToCommittedPan() {
        // The live compositor pan must equal the pan the release commits AND be
        // clamped to the legal region (so the image can't detach the viewport
        // edge). The host scales the frozen frame about its centre and offsets
        // by this pan, so live visual == commit → no jump on release.
        let controller = makeController()
        let focal = CGPoint(x: 500, y: 400)
        controller.pinchChanged(magnification: 1.0, location: focal)

        let live = CGPoint(x: 0, y: 0)        // large drift toward the top-left
        let t = controller.gestureTransform(magnification: 2.0, liveCentroid: live)
        XCTAssertEqual(t.zoom, 2.0, accuracy: 1e-9, "fit→2× pinch from fit")
        // Unclamped this pan would be (−500, −400); at 2× max pan is (500, 350),
        // so the height clamps to −350 (the image stays attached on the bottom).
        XCTAssertEqual(t.committedPan.width, -500, accuracy: 1e-6)
        XCTAssertEqual(t.committedPan.height, -350, accuracy: 1e-6)

        // The live pan equals the pan the gesture actually commits — no jump.
        controller.pinchChanged(magnification: 2.0, location: live)
        controller.pinchEnded(magnification: 2.0)
        XCTAssertEqual(controller.panOffset.width, t.committedPan.width, accuracy: 1e-6)
        XCTAssertEqual(controller.panOffset.height, t.committedPan.height, accuracy: 1e-6)
    }

    func testGestureTransformFromAlreadyPannedStateMatchesCommit() {
        // The exact bug this fix repairs: pinching from an already-zoomed +
        // PANNED state used to commit to a wrong position (the start pan
        // mis-anchored the scale). With the centre-scale + committed-pan model
        // the live `committedPan` must equal the actual committed pan even when
        // the start pan is non-zero — for an off-centre focal, unclamped.
        let controller = makeController()
        controller.zoomToScale(1.0)                                   // 100%
        controller.dragChanged(translation: CGSize(width: -300, height: -200))
        controller.dragEnded()
        XCTAssertNotEqual(controller.panOffset, .zero, "precondition: panned start")

        let focal = CGPoint(x: 400, y: 300)                          // off-centre
        controller.pinchChanged(magnification: 1.0, location: focal) // capture start
        let live = CGPoint(x: 450, y: 280)                           // small drift
        let t = controller.gestureTransform(magnification: 1.5, liveCentroid: live)
        XCTAssertEqual(t.zoom, 1.5, accuracy: 1e-9)
        // Focal-anchored pan from the panned start (within the legal range at 1.5×).
        XCTAssertEqual(t.committedPan.width, -350, accuracy: 1e-6)
        XCTAssertEqual(t.committedPan.height, -270, accuracy: 1e-6)

        controller.pinchChanged(magnification: 1.5, location: live)
        controller.pinchEnded(magnification: 1.5)
        XCTAssertEqual(controller.panOffset.width, t.committedPan.width, accuracy: 1e-6)
        XCTAssertEqual(controller.panOffset.height, t.committedPan.height, accuracy: 1e-6)
    }
}
