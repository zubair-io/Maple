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
// swap brightness mid-pinch"). Wheel-pan (trackpad two-finger scroll,
// #2036) follows the same "commit once" contract via a debounce —
// every event updates the model but the commit is deferred until the
// scroll stream goes idle, since a continuous scroll fires far too
// often to commit synchronously per event. Wheel-zoom, keyboard,
// toolbar, and double-tap remain genuinely discrete inputs and commit
// immediately.
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
    ///
    /// Uses `session.effectiveImageSize` (#638) rather than the raw
    /// `nativeImageSize`: when a crop is applied (and the crop tool is not
    /// armed) the canvas, fit/100%/pan, and the visible-tile rect all key
    /// off the CROPPED extent so the cropped result fills the frame instead
    /// of being letterboxed inside the full-sensor rect. While the crop
    /// tool is armed `effectiveImageSize` resolves back to the full frame
    /// (the overlay sits over the uncropped image).
    public var context: CanvasZoomContext {
        CanvasZoomContext(
            viewportPoints: viewportPoints,
            nativeImageSize: session.effectiveImageSize,
            displayScale: displayScale
        )
    }

    /// `pixelScale` with the `0 == fit` sentinel resolved.
    public var effectivePixelScale: CGFloat {
        context.effectiveScale(for: model.pixelScale)
    }

    /// Live pinch transform for the iOS host's compositor `.scaleEffect(anchor:
    /// .center)` + `.offset` (#1493): the scale factor relative to the
    /// start-captured scale, and the would-be COMMITTED pan. Both use the SAME
    /// clamps the release will — `pinchScale` for the scale, `clampedPan` for the
    /// pan — so the live visual can't over-zoom or detach the image, and the pan
    /// (which carries the focal anchor via `livePinchPan`) makes the live visual
    /// land exactly on the committed `panOffset`: scaling the frozen frame about
    /// its centre and offsetting by `committedPan` reproduces the committed
    /// geometry, so there's no jump on release. Call only between the start
    /// `pinchChanged` (magnification 1) and `pinchEnded`.
    public func gestureTransform(
        magnification: CGFloat,
        liveCentroid: CGPoint
    ) -> (zoom: CGFloat, committedPan: CGSize) {
        // Require the start-capture frame (`pinchChanged` magnification 1) to
        // have run: the pan is derived from `pinchStartCentroid`/`Pan`, which
        // default to .zero, so without a capture the result would be computed
        // from an inconsistent start state. No capture → identity transform.
        guard let start = model.pinchStartScale, start > 0 else { return (1, .zero) }
        let next = CanvasZoomModel.pinchScale(
            start: start, magnification: magnification, fit: context.fitScale
        )
        let committed = context.clampedPan(
            CanvasZoomModel.livePinchPan(
                liveCentroid: liveCentroid,
                startCentroid: model.pinchStartCentroid,
                startPan: model.pinchStartPan,
                startScale: start, newScale: next,
                viewportPoints: context.viewportPoints
            ),
            at: next
        )
        return (next / start, committed)
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

    /// Absorb a drag's running translation into the baseline without panning —
    /// used by the host during the post-pinch cooldown so the lingering finger
    /// can't pan, yet a deliberate pan that continues past the cooldown resumes
    /// smoothly (#1509).
    public func rebaseDrag(translation: CGSize) {
        model.rebaseDragBaseline(translation)
    }

    /// Double-tap / double-click per the configured behavior.
    public func doubleTap(at location: CGPoint, behavior: CanvasZoomModel.DoubleTapBehavior) {
        model.doubleTap(at: location, behavior: behavior, context: context)
        commitToSession()
    }

    /// Two-finger scroll / wheel pan while zoomed (deltas in points).
    /// Model-only per event — the debounced commit below coalesces the
    /// stream, matching the drag/pinch "commit once" contract (#2036).
    /// Trackpad two-finger scroll emits dozens of events/sec; a
    /// synchronous per-event commit reaches `updateTileVisibleRegion`,
    /// which clears the native-detail overlay (visible sharp→blurry
    /// flicker for the whole pan) and reschedules a refine Task on every
    /// event.
    public func wheelPan(delta: CGSize) {
        guard model.isZoomedIn else { return }
        model.wheelPan(by: delta, context: context)
        scheduleWheelPanCommit()
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

    // MARK: - Wheel-pan commit debounce (#2036)

    /// Wheel-pan commit debounce — a continuous trackpad two-finger
    /// scroll fires dozens of events per second; committing per event
    /// (the previous behaviour) forced a native-detail clear + refine
    /// reschedule on every one. 120 ms comfortably exceeds the gap
    /// between consecutive scroll-wheel events (including a momentum
    /// tail) while still committing promptly once the pan actually
    /// stops.
    public static let wheelPanCommitDebounceMilliseconds: UInt64 = 120

    /// Interval `scheduleWheelPanCommit` actually sleeps. A stored
    /// (not static) value so `_testSetWheelPanCommitInterval` can shrink
    /// it for a fast coalescing test; production never touches this.
    private var wheelPanCommitIntervalMilliseconds: UInt64 =
        CanvasZoomController.wheelPanCommitDebounceMilliseconds

    /// Pending debounced commit — cancelled and replaced on every
    /// `wheelPan` event so only the tail of a continuous scroll (momentum
    /// included, since momentum just extends the event stream) survives
    /// to actually commit. Same cancel-previous-task idiom as
    /// `RenderActor.refineTask`.
    private var wheelPanCommitTask: Task<Void, Never>?

    /// (Re)arms the debounced wheel-pan commit. Cancelling the previous
    /// pending Task on every call means a steady stream of events keeps
    /// pushing the commit out; it only fires once the stream goes idle
    /// for `wheelPanCommitIntervalMilliseconds`.
    private func scheduleWheelPanCommit() {
        wheelPanCommitTask?.cancel()
        let intervalMilliseconds = wheelPanCommitIntervalMilliseconds
        // `@MainActor` documents the isolation the closure already inherits
        // from this @MainActor class (SE-0306: unstructured Tasks inherit
        // the enclosing actor context) — explicit for readers, zero
        // behavior change.
        wheelPanCommitTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(intervalMilliseconds)))
            guard !Task.isCancelled else { return }
            self?._testWheelPanCommitFireCount += 1
            self?.commitToSession()
        }
    }

    // MARK: - Test hooks

    /// Shrinks the wheel-pan commit debounce so a coalescing test doesn't
    /// have to sleep the production 120 ms per assertion.
    internal func _testSetWheelPanCommitInterval(milliseconds: UInt64) {
        wheelPanCommitIntervalMilliseconds = milliseconds
    }

    /// Number of times the debounced wheel-pan commit has actually fired
    /// (i.e. survived to the end of its sleep uncancelled). `Task.isCancelled`
    /// stays `false` after a task simply completes, so it can't distinguish
    /// "pending" from "already fired" — this counter is the reliable signal
    /// a coalescing test needs.
    internal private(set) var _testWheelPanCommitFireCount = 0

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
        // Any commit supersedes a pending debounced wheel-pan commit — both
        // would push the same current model state, so letting the debounce
        // fire later would only re-trigger `updateTileVisibleRegion` for
        // nothing (PR #2047 review).
        wheelPanCommitTask?.cancel()
        wheelPanCommitTask = nil
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

