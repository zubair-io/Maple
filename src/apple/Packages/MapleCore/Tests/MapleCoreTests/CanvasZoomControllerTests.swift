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
        // Pan-while-pinch toward a corner: the live compositor drift must be
        // clamped to the same legal region the commit uses, so the visual can't
        // overshoot the viewport edge and snap back on release. With the focal
        // at the viewport centre the focal-anchored pan is zero, so the live net
        // pan IS the drift — assert it equals the committed pan and that it was
        // clamped (the image stays attached).
        let controller = makeController()
        let focal = CGPoint(x: 500, y: 400)   // viewport centre → focalPan == 0
        controller.pinchChanged(magnification: 1.0, location: focal)

        let live = CGPoint(x: 0, y: 0)        // large drift toward the top-left
        let t = controller.gestureTransform(magnification: 2.0, liveCentroid: live)
        XCTAssertEqual(t.zoom, 2.0, accuracy: 1e-9, "fit→2× pinch from fit")
        // Unclamped this pan would be (−500, −400); at 2× max pan is (500, 350),
        // so the height clamps to −350 (the image stays attached on the bottom).
        XCTAssertEqual(t.drift.width, -500, accuracy: 1e-6)
        XCTAssertEqual(t.drift.height, -350, accuracy: 1e-6)

        // The live drift equals the pan the gesture actually commits — no snap.
        controller.pinchChanged(magnification: 2.0, location: live)
        controller.pinchEnded(magnification: 2.0)
        XCTAssertEqual(controller.panOffset.width, t.drift.width, accuracy: 1e-6)
        XCTAssertEqual(controller.panOffset.height, t.drift.height, accuracy: 1e-6)
    }
}
