// CanvasZoomController.swift — observable zoom state + EditSession plumbing (#1099).
//
// Thin @Observable wrapper over the pure `CanvasZoomModel`: it owns the
// live zoom state for one canvas surface and forwards every committed
// change into the `EditSession` exactly the way the legacy
// `FullImageView` did —
//
//   • `previewSize` (real px) on viewport mount / resize, so the fast
//     phase renders at viewport resolution,
//   • the resolved `pixelScale` whenever it changes, so the refine pass
//     retargets (`nativeImageSize × min(pixelScale, 1)`),
//   • `updateTileVisibleRegion(viewport:zoom:)` on every commit —
//     zoom/pan gestures AND viewport resizes / native-size seeds — so
//     the deep-zoom tile manager always sees the live viewport.
//
// Gesture-live updates (pinch frames, drag frames) mutate only the
// model — the session is committed on gesture END, matching the legacy
// contract ("commit once on release so target-size refinements don't
// swap brightness mid-pinch"). Discrete inputs (wheel, keyboard,
// toolbar, double-tap) commit immediately.
//
// Lives in MapleCore so the editor (`EditorState`), the legacy full-image
// surface, and the S4 loupe (#577) share one implementation, and so the
// session plumbing is unit-testable next to the model.

import Foundation
import CoreGraphics

@MainActor
@Observable
public final class CanvasZoomController {
    /// The session this canvas renders. The controller's lifetime is
    /// bound to one session — hosts rebuild the controller when the
    /// asset/session changes (and `assetChanged()` guards view reuse).
    public let session: EditSession

    /// Live zoom state. Mutations go through the methods below so every
    /// state change lands in the session when it must.
    public private(set) var model = CanvasZoomModel()

    /// Last viewport reported by the host, in points.
    public private(set) var viewportPoints: CGSize = .zero
    /// Points → real-pixels factor reported by the host.
    public private(set) var displayScale: CGFloat = 1

    public init(session: EditSession) {
        self.session = session
    }

    // MARK: - Derived geometry

    /// Geometry snapshot for the current viewport + session extent.
    public var context: CanvasZoomContext {
        CanvasZoomContext(
            viewportPoints: viewportPoints,
            nativeImageSize: session.nativeImageSize,
            displayScale: displayScale
        )
    }

    /// `pixelScale` with the `0 == fit` sentinel resolved.
    public var effectivePixelScale: CGFloat {
        context.effectiveScale(for: model.pixelScale)
    }

    /// On-screen image frame (points) at the current zoom. `nil` until
    /// the native size is seeded — consumers show their fallback.
    public var displayFrameInPoints: CGSize? {
        context.displayFrameInPoints(at: model.pixelScale)
    }

    /// Pan offset in points (positive = image dragged right/down).
    public var panOffset: CGSize { model.panOffset }

    /// True when the user has explicitly zoomed (not fit mode).
    public var isZoomedIn: Bool { model.isZoomedIn }

    /// Drag arbitration for the host (spec §5.0 table).
    public var dragIntent: CanvasZoomModel.DragIntent { model.dragIntent }

    /// Wheel arbitration for the host (spec §5.0 table).
    public func wheelIntent(commandHeld: Bool) -> CanvasZoomModel.WheelIntent {
        model.wheelIntent(commandHeld: commandHeld)
    }

    // MARK: - View plumbing

    /// Host viewport mount / resize. Re-clamps the pan against the new
    /// geometry, pushes the real-pixel viewport into `previewSize`
    /// (fast-phase target), then commits the resolved scale AND the
    /// recomputed visible source rect — the visible rect depends on the
    /// viewport, so a resize that skipped the commit would leave
    /// deep-zoom consumers acting on a stale region (#1125 review).
    public func viewportChanged(points: CGSize, displayScale: CGFloat) {
        guard points.width > 0, points.height > 0 else { return }
        self.viewportPoints = points
        self.displayScale = displayScale
        model.reclampPan(context: context)
        session.previewSize = context.viewportPx
        commitToSession()
    }

    /// The metadata seed published a real `nativeImageSize` — re-resolve
    /// fit so the idle refine targets viewport resolution instead of the
    /// pre-decode estimate (legacy `syncSessionToViewport` on the same
    /// change), and re-push the visible rect, which depends on the image
    /// extent (#1125 review).
    public func nativeImageSizeChanged() {
        guard viewportPoints != .zero else { return }
        model.reclampPan(context: context)
        session.previewSize = context.viewportPx
        commitToSession()
    }

    /// The host's asset switched under a reused view — reset to fit so a
    /// stale zoom doesn't make the new image's refine pass target the
    /// full native extent.
    public func assetChanged() {
        model.resetToFit()
        guard viewportPoints != .zero else { return }
        session.previewSize = context.viewportPx
        commitToSession()
    }

    // MARK: - Gestures

    /// Pinch frame (cumulative `magnification` since gesture start,
    /// anchor in viewport points). Model-only — committed on end.
    public func pinchChanged(magnification: CGFloat, location: CGPoint) {
        model.pinchChanged(magnification: magnification, location: location, context: context)
    }

    /// Pinch release — commits the resolved scale + visible rect.
    public func pinchEnded(magnification: CGFloat) {
        model.pinchEnded(magnification: magnification, context: context)
        commitToSession()
    }

    /// Drag frame. No-op at fit (the drag belongs to the editing
    /// surface); pans when zoomed. Model-only — committed on end.
    public func dragChanged(translation: CGSize) {
        model.dragChanged(translation: translation, context: context)
    }

    /// Drag release — pushes the new visible rect when a pan committed.
    public func dragEnded() {
        if model.dragEnded() {
            commitToSession()
        }
    }

    /// Double-tap / double-click per the configured behavior.
    public func doubleTap(at location: CGPoint, behavior: CanvasZoomModel.DoubleTapBehavior) {
        model.doubleTap(at: location, behavior: behavior, context: context)
        commitToSession()
    }

    /// Two-finger scroll / wheel pan while zoomed (deltas in points).
    public func wheelPan(delta: CGSize) {
        guard model.isZoomedIn else { return }
        model.wheelPan(by: delta, context: context)
        commitToSession()
    }

    /// Cmd+scroll zoom anchored at the cursor (normalized delta —
    /// positive zooms in).
    public func wheelZoom(normalizedDeltaY: CGFloat, location: CGPoint) {
        model.wheelZoom(normalizedDeltaY: normalizedDeltaY, location: location, context: context)
        commitToSession()
    }

    // MARK: - Commands (toolbar / keyboard)

    /// Fit (⌘0).
    public func resetToFit() {
        model.resetToFit()
        commitToSession()
    }

    /// 100% (⌘1) — or any explicit scale.
    public func zoomToScale(_ scale: CGFloat) {
        model.zoomToScale(scale)
        commitToSession()
    }

    /// Zoom in one step (⌘=).
    public func stepZoomIn() {
        model.stepZoomIn(context: context)
        commitToSession()
    }

    /// Zoom out one step (⌘-).
    public func stepZoomOut() {
        model.stepZoomOut(context: context)
        commitToSession()
    }

    // MARK: - Session commit

    /// Push the resolved zoom + visible source rect into the session.
    /// `updateTileVisibleRegion` owns both the `pixelScale` write (its
    /// `didSet` reschedules the refine) and the pure-pan refine kick, so
    /// one call covers every commit path — same contract the legacy
    /// `FullImageView.notifyVisibleRegion()` had.
    ///
    /// No-ops until the host has reported a real viewport: against a
    /// degenerate viewport `CanvasMath` resolves fit to 1, so an early
    /// commit (toolbar shortcut firing before the first
    /// `viewportChanged`) would write a wrong `session.pixelScale` and
    /// schedule refines against the wrong target (#1125 review). The
    /// model already holds the user's intent, so the skipped commit
    /// flushes naturally on the next `viewportChanged` — which always
    /// commits.
    private func commitToSession() {
        guard viewportPoints.width > 0, viewportPoints.height > 0 else { return }
        let math = context.canvasMath(
            pixelScale: model.pixelScale,
            panOffset: model.panOffset
        )
        session.updateTileVisibleRegion(
            viewport: math.visibleSourceRect,
            zoom: math.effectivePixelScale
        )
    }
}

