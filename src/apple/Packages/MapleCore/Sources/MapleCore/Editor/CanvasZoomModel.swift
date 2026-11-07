// CanvasZoomModel.swift — pure zoom/pan/gesture state machine (#1099).
//
// The arbitration + transition math behind the shared canvas zoom host
// (spec §5.0, docs/zoom.md). Extracted from the legacy `FullImageView`'s
// `@State` + `FullImageViewVM` pair so the same rules drive the S5
// `EditorView`, the legacy full-image surface, and (under #577) the S4
// loupe — and so the state logic is unit-testable without SwiftUI.
//
// Model (docs/zoom.md):
//   • `pixelScale` is REAL screen pixels per image pixel.
//       – 0    = fit-to-viewport (resolved at read time)
//       – fit × 0.5 = floor (zoomed out, background around the image)
//       – fill = image covers the whole viewport (tracked across resizes)
//       – 1.0  = pixel-perfect 100% (1 image px = 1 real screen px)
//       – 8.0  = maximum zoom (cap)
//   • Pinch anchors against a start-captured scale (`MagnifyGesture`'s
//     `magnification` is cumulative — multiplying it into the live scale
//     every frame compounds exponentially).
//   • Pinch detents: within `detentTolerance` of fit or fill a pinch
//     settles exactly there (live and on release).
//   • Pan is clamped so the image never detaches from the viewport:
//     edges may meet the viewport edge but a gap can't open, and an
//     image smaller than the viewport stays centered.
//
// Gesture arbitration (spec §5.0 table) is exposed as intents
// (`dragIntent(context:)`, `wheelIntent(commandHeld:context:)`) so hosts
// route inputs without re-deriving the pannable-vs-editing rule.

import Foundation
import CoreGraphics

// MARK: - Context

/// Immutable per-call geometry the zoom transitions resolve against:
/// the live viewport (points), the trustworthy image extent, and the
/// points→real-pixels factor. Built fresh by the controller for every
/// transition so the math always sees the current viewport.
public struct CanvasZoomContext: Equatable, Sendable {
    /// Viewport size in POINTS (SwiftUI geometry).
    public let viewportPoints: CGSize
    /// Native image size in oriented source pixels (`.zero` until the
    /// metadata seed fires — derived values degrade per `CanvasMath`).
    public let nativeImageSize: CGSize
    /// Points → real-pixels factor (display backing scale).
    public let displayScale: CGFloat

    public init(viewportPoints: CGSize, nativeImageSize: CGSize, displayScale: CGFloat) {
        self.viewportPoints = viewportPoints
        self.nativeImageSize = nativeImageSize
        self.displayScale = max(displayScale, 0.001)
    }

    /// Viewport in REAL screen pixels — what the render pipeline targets.
    public var viewportPx: CGSize {
        CGSize(width: viewportPoints.width * displayScale,
               height: viewportPoints.height * displayScale)
    }

    /// `CanvasMath` snapshot for a given user-intent scale + pan.
    public func canvasMath(pixelScale: CGFloat, panOffset: CGSize = .zero) -> CanvasMath {
        CanvasMath(
            viewportPx: viewportPx,
            nativeImageSize: nativeImageSize,
            pixelScale: pixelScale,
            panOffset: panOffset,
            displayScale: displayScale
        )
    }

    /// Real-pixels-per-image-pixel for fit-to-viewport.
    public var fitScale: CGFloat {
        canvasMath(pixelScale: 0).fitPixelScale
    }

    /// Real-pixels-per-image-pixel at which the image covers the whole
    /// viewport, capped at `CanvasZoomModel.maxPixelScale`.
    public var fillScale: CGFloat {
        min(canvasMath(pixelScale: 0).fillPixelScale, CanvasZoomModel.maxPixelScale)
    }

    /// Smallest legal scale: `fit × minFitFraction`.
    public var minScale: CGFloat {
        fitScale * CanvasZoomModel.minFitFraction
    }

    /// Resolves the `0 == fit` sentinel into a concrete scale.
    public func effectiveScale(for pixelScale: CGFloat) -> CGFloat {
        canvasMath(pixelScale: pixelScale).effectivePixelScale
    }

    /// On-screen frame (points) of the image at `pixelScale`. `nil`
    /// until the native size is seeded.
    public func displayFrameInPoints(at pixelScale: CGFloat) -> CGSize? {
        canvasMath(pixelScale: pixelScale).displayFrameInPoints
    }

    /// Largest pan magnitude (points, per axis) that keeps the image
    /// attached to the viewport at `pixelScale`. Zero on an axis where
    /// the image is no larger than the viewport (stays centered).
    public func maxPanOffset(at pixelScale: CGFloat) -> CGSize {
        guard let frame = displayFrameInPoints(at: pixelScale) else { return .zero }
        return CGSize(
            width: max(0, (frame.width - viewportPoints.width) / 2),
            height: max(0, (frame.height - viewportPoints.height) / 2)
        )
    }

    /// Clamp a pan offset into the legal range at `pixelScale`.
    public func clampedPan(_ pan: CGSize, at pixelScale: CGFloat) -> CGSize {
        let limit = maxPanOffset(at: pixelScale)
        return CGSize(
            width: min(max(pan.width, -limit.width), limit.width),
            height: min(max(pan.height, -limit.height), limit.height)
        )
    }
}

// MARK: - Model

public struct CanvasZoomModel: Equatable, Sendable {
    // MARK: State

    /// User-intent pixel scale: 0 = fit, 1 = 100%, ≤ `maxPixelScale`.
    public internal(set) var pixelScale: CGFloat = 0
    /// Pan offset in points. Positive = image dragged right/down.
    public internal(set) var panOffset: CGSize = .zero
    /// Pan committed at the end of the last drag — live drags accumulate
    /// `translation` on top of this.
    public internal(set) var basePan: CGSize = .zero
    /// The simultaneous SwiftUI `DragGesture` reports `translation` cumulative
    /// from the touch-sequence start and never resets when a pinch ends. While
    /// a pinch suppresses the drag we record the latest translation here so a
    /// post-pinch drag (a finger lifted, one still down) measures deltas from
    /// this baseline instead of jumping by the whole pinch-time travel.
    public internal(set) var dragTranslationBase: CGSize?
    /// Scale captured at pinch start (compounding guard + snap basis).
    public internal(set) var pinchStartScale: CGFloat?
    /// Pan captured at pinch start. Each frame re-derives the pan from these
    /// start values (not the previous, possibly-clamped frame) so per-frame
    /// pan clamping can't accumulate and drift the zoom anchor.
    public internal(set) var pinchStartPan: CGSize = .zero
    /// Centroid (viewport points) captured at pinch start — the scale change
    /// anchors here, then translates by how far the live centroid has moved.
    public internal(set) var pinchStartCentroid: CGPoint = .zero
    /// Most recent live centroid — lets `pinchEnded` finalise at the same
    /// focal point the last `pinchChanged` used.
    public internal(set) var pinchLastCentroid: CGPoint = .zero
    /// True while the zoom is the fill stop. Fill is resolution-dependent,
    /// so `reclampPan` re-resolves it when the viewport or image changes
    /// (a rotation keeps the image covering the screen).
    public internal(set) var fillsViewport = false

    public init() {}

    // MARK: Constants (single source of truth — moved from FullImageViewVM)

    /// Upper clamp on `pixelScale` — 8× (800%) per docs/zoom.md.
    public static let maxPixelScale: CGFloat = 8.0
    /// Floor for explicit zoom targets (toolbar / keyboard) so a
    /// programmatic 0 can't silently re-enter fit mode.
    public static let minExplicitZoom: CGFloat = 0.05
    /// ⌘= / ⌘- step — 1.25 gives the classic five-steps-to-double feel.
    public static let zoomStep: CGFloat = 1.25
    /// Detent band, as a fraction of the stop's scale: a pinch within 4%
    /// of fit or fill settles there; a step out that lands within it of
    /// fit resets to true fit mode (`pixelScale = 0`).
    public static let detentTolerance: CGFloat = 0.04
    /// Zoom-out floor as a fraction of fit — the image at half its fit
    /// size, centred, with background around it.
    public static let minFitFraction: CGFloat = 0.5
    /// Cmd+scroll zoom sensitivity: scale multiplies by
    /// `exp2(normalizedDeltaY × this)` per wheel event.
    public static let wheelZoomSensitivity: CGFloat = 0.015

    // MARK: Arbitration intents (spec §5.0 table)

    /// True when the user has explicitly zoomed (`pixelScale != 0`) — in
    /// or out of fit. Fit mode keeps `0`.
    public var isZoomedIn: Bool { pixelScale > 0 }

    /// True when the image overflows the viewport on some axis, so a drag
    /// or plain wheel has something to pan. False at fit and below it,
    /// where those inputs belong to the editing surface.
    public func canPan(context: CanvasZoomContext) -> Bool {
        isZoomedIn && context.maxPanOffset(at: pixelScale) != .zero
    }

    /// Where a one-finger / mouse drag on the canvas routes.
    public enum DragIntent: Equatable, Sendable {
        /// Nothing to pan (fit or below) — the drag belongs to the editing
        /// surface (armed-tool scrub, system edge-swipe). The zoom host
        /// must not consume it.
        case editing
        /// The image overflows the viewport — the drag pans it.
        case pan
    }

    public func dragIntent(context: CanvasZoomContext) -> DragIntent {
        canPan(context: context) ? .pan : .editing
    }

    /// Where a scroll-wheel event over the canvas routes.
    public enum WheelIntent: Equatable, Sendable {
        /// Cmd held — zoom anchored at the cursor (any zoom state).
        case zoom
        /// Image overflows the viewport, no modifier — pan.
        case pan
        /// Nothing to pan, no modifier — armed-tool nudge (host-defined).
        case editing
    }

    public func wheelIntent(commandHeld: Bool, context: CanvasZoomContext) -> WheelIntent {
        if commandHeld { return .zoom }
        return canPan(context: context) ? .pan : .editing
    }

    /// Double-tap / double-click behavior, configured per surface.
    public enum DoubleTapBehavior: Equatable, Sendable {
        /// Legacy full-image surface: always return to fit.
        case resetToFit
        /// S5 editor (spec §5.0): fit ↔ 100% toggle — pixel-perfect is
        /// what you need to judge NR / sharpening.
        case toggleFitAnd100
    }

    // Pure scale/pan geometry helpers (pinchScale, anchoredPan, livePinchPan,
    // the zoom-step targets) live in CanvasZoomModel+Geometry.swift.

    // MARK: Transitions — pinch

    /// Per-frame pinch update. Captures the start scale / pan / anchor
    /// exactly once (first `onChanged`), then derives the live scale
    /// from the START values so cumulative magnification can't compound.
    public mutating func pinchChanged(
        magnification: CGFloat,
        location: CGPoint,
        context: CanvasZoomContext
    ) {
        let isCaptureFrame = pinchStartScale == nil
        let start = pinchStartScale ?? context.effectiveScale(for: pixelScale)
        if isCaptureFrame {
            pinchStartScale = start
            pinchStartPan = panOffset
            pinchStartCentroid = location
        }
        // The iOS compositor freezes the frame at this capture and scales it
        // by `gestureTransform`'s ratio to `start`; snapping a start that sits
        // inside a detent band here would count the detent twice (#5710).
        guard !(isCaptureFrame && magnification == 1) else {
            pinchLastCentroid = location
            return
        }
        let next = Self.pinchScale(
            start: start, magnification: magnification,
            fit: context.fitScale, fill: context.fillScale)
        pixelScale = next
        fillsViewport = false
        panOffset = context.clampedPan(
            Self.livePinchPan(
                liveCentroid: location,
                startCentroid: pinchStartCentroid,
                startPan: pinchStartPan,
                startScale: start,
                newScale: next,
                viewportPoints: context.viewportPoints
            ),
            at: next
        )
        pinchLastCentroid = location
    }

    /// Pinch release: commit the final scale, settle on the fit or fill
    /// detent when the gesture ended within its band, clear the start
    /// capture.
    public mutating func pinchEnded(magnification: CGFloat, context: CanvasZoomContext) {
        let fit = context.fitScale
        let fill = context.fillScale
        // Commit the final scale anchored at the same focal point the last
        // frame used (derived from the START values). When `pinchStartScale`
        // is nil the gesture ended without a change frame — leave it untouched.
        if let start = pinchStartScale {
            let final = Self.pinchScale(
                start: start, magnification: magnification, fit: fit, fill: fill)
            pixelScale = final
            panOffset = context.clampedPan(
                Self.livePinchPan(
                    liveCentroid: pinchLastCentroid,
                    startCentroid: pinchStartCentroid,
                    startPan: pinchStartPan,
                    startScale: start,
                    newScale: final,
                    viewportPoints: context.viewportPoints
                ),
                at: final
            )
        }
        pinchStartScale = nil
        pinchStartPan = .zero
        pinchStartCentroid = .zero
        pinchLastCentroid = .zero

        switch Self.detent(for: context.effectiveScale(for: pixelScale), fit: fit, fill: fill) {
        case .fit:
            resetToFit()
        case .fill:
            pixelScale = fill
            fillsViewport = true
            panOffset = context.clampedPan(panOffset, at: fill)
            basePan = panOffset
        case .actualSize, nil:
            basePan = panOffset
        }
    }

    // MARK: Transitions — drag

    /// Per-frame drag update. Returns `true` when the drag was consumed
    /// as a pan (zoomed in); `false` at fit, where the drag belongs to
    /// the editing surface and the model must not move.
    @discardableResult
    public mutating func dragChanged(translation: CGSize, context: CanvasZoomContext) -> Bool {
        // A two-finger pinch also fires the simultaneous drag gesture (the
        // touch centroid moves). While a pinch is active the pinch owns pan —
        // letting the drag write `panOffset` too means two writers fight every
        // frame. Record the running translation so that if the pinch ends with
        // a finger still down, the resuming drag measures deltas from here and
        // doesn't jump by the whole pinch-time travel.
        guard pinchStartScale == nil else {
            dragTranslationBase = translation
            return false
        }
        guard canPan(context: context) else { return false }
        let base = dragTranslationBase ?? .zero
        let raw = CGSize(
            width: basePan.width + translation.width - base.width,
            height: basePan.height + translation.height - base.height
        )
        panOffset = context.clampedPan(raw, at: pixelScale)
        return true
    }

    /// Drag release: commit the accumulated pan. Returns `true` when a
    /// pan was committed (callers push the new visible rect on commit).
    @discardableResult
    public mutating func dragEnded() -> Bool {
        // The touch sequence is over — the next drag starts a fresh baseline.
        dragTranslationBase = nil
        // If a pinch still owns the gesture (both fingers lifting together can
        // deliver the drag-end before the pinch-end), the pinch commits the
        // pan — the suppressed drag must not, or it both re-commits a pan the
        // drag never performed and fires a mid-pinch session commit (the host's
        // `dragEnded` calls `commitToSession`), defeating "pinch owns pan".
        guard pinchStartScale == nil else { return false }
        guard isZoomedIn else { return false }
        basePan = panOffset
        return true
    }

    /// Track the drag's running translation WITHOUT panning. The host calls
    /// this during the post-pinch cooldown so the lingering-finger movement is
    /// absorbed into the baseline — when the cooldown ends, a deliberate
    /// continued pan resumes from here with no accumulated jump.
    public mutating func rebaseDragBaseline(_ translation: CGSize) {
        dragTranslationBase = translation
    }

    // MARK: Transitions — wheel

    /// Two-finger scroll / wheel pan while zoomed in. Deltas are in
    /// points (host normalizes line-based wheels before calling).
    public mutating func wheelPan(by delta: CGSize, context: CanvasZoomContext) {
        guard isZoomedIn else { return }
        let raw = CGSize(width: panOffset.width + delta.width,
                         height: panOffset.height + delta.height)
        panOffset = context.clampedPan(raw, at: pixelScale)
        basePan = panOffset
    }

    /// Cmd+scroll zoom anchored at the cursor. `normalizedDeltaY` is the
    /// wheel delta with line-based events already scaled by the host;
    /// positive zooms in. Snap-to-fit applies immediately (wheel zoom
    /// has no "gesture end").
    public mutating func wheelZoom(
        normalizedDeltaY: CGFloat,
        location: CGPoint,
        context: CanvasZoomContext
    ) {
        let fit = context.fitScale
        let current = context.effectiveScale(for: pixelScale)
        let factor = exp2(normalizedDeltaY * Self.wheelZoomSensitivity)
        let next = max(context.minScale, min(current * factor, Self.maxPixelScale))
        if Self.crossesFit(from: current, to: next, fit: fit) {
            resetToFit()
            return
        }
        fillsViewport = false
        panOffset = context.clampedPan(
            Self.anchoredPan(
                anchor: location,
                viewportPoints: context.viewportPoints,
                startPan: panOffset,
                startScale: current,
                newScale: next
            ),
            at: next
        )
        basePan = panOffset
        pixelScale = next
    }

    // MARK: Transitions — taps + commands

    /// Double-tap / double-click per the configured behavior. The
    /// editor toggles fit ↔ 100% (zoom-in anchored at the tap point);
    /// the legacy surface always returns to fit.
    public mutating func doubleTap(
        at location: CGPoint,
        behavior: DoubleTapBehavior,
        context: CanvasZoomContext
    ) {
        switch behavior {
        case .resetToFit:
            resetToFit()
        case .toggleFitAnd100:
            if isZoomedIn {
                resetToFit()
            } else {
                let start = context.effectiveScale(for: pixelScale)
                let target: CGFloat = 1.0
                fillsViewport = false
                panOffset = context.clampedPan(
                    Self.anchoredPan(
                        anchor: location,
                        viewportPoints: context.viewportPoints,
                        startPan: panOffset,
                        startScale: start,
                        newScale: target
                    ),
                    at: target
                )
                basePan = panOffset
                pixelScale = target
            }
        }
    }

    /// Back to fit mode: `pixelScale = 0`, pans cleared.
    public mutating func resetToFit() {
        pixelScale = 0
        fillsViewport = false
        panOffset = .zero
        basePan = .zero
        dragTranslationBase = nil
        pinchStartScale = nil
        pinchStartPan = .zero
        pinchStartCentroid = .zero
        pinchLastCentroid = .zero
    }

    /// Explicit zoom target (toolbar "100%", ⌘1). Clamped; pan resets
    /// so the view re-centers — matching the legacy toolbar semantics.
    public mutating func zoomToScale(_ scale: CGFloat) {
        pixelScale = Self.clampedExplicitZoom(scale)
        fillsViewport = false
        panOffset = .zero
        basePan = .zero
    }

    /// ⌘= step. Anchored at the viewport center: the pan scales with
    /// the zoom ratio so the content under the center stays put, then
    /// clamps.
    public mutating func stepZoomIn(context: CanvasZoomContext) {
        let current = context.effectiveScale(for: pixelScale)
        let next = Self.zoomInTarget(current: current)
        guard !Self.crossesFit(from: current, to: next, fit: context.fitScale) else {
            resetToFit()
            return
        }
        rescalePan(from: current, to: next, context: context)
        pixelScale = next
        fillsViewport = false
    }

    /// ⌘- step. Snaps to fit within tolerance, otherwise steps down and
    /// re-clamps the pan against the smaller frame.
    public mutating func stepZoomOut(context: CanvasZoomContext) {
        let fit = context.fitScale
        let current = context.effectiveScale(for: pixelScale)
        switch Self.zoomOutTarget(current: current, fit: fit) {
        case .snapToFit:
            resetToFit()
        case .scale(let next):
            rescalePan(from: current, to: next, context: context)
            pixelScale = next
            fillsViewport = false
        }
    }

    /// Re-clamp the pan against fresh geometry (viewport resize, native
    /// size seed). Keeps the image attached to the viewport when the
    /// window shrinks around a panned, zoomed-in canvas, and keeps the
    /// fill stop covering the new viewport.
    public mutating func reclampPan(context: CanvasZoomContext) {
        guard isZoomedIn else { return }
        if fillsViewport {
            guard Self.badgeStops(context: context).contains(.fill) else {
                resetToFit()
                return
            }
            pixelScale = context.fillScale
        }
        let clamped = context.clampedPan(panOffset, at: pixelScale)
        guard clamped != panOffset else { return }
        panOffset = clamped
        basePan = clamped
    }

    /// Center-anchored pan rescale shared by the step zooms.
    private mutating func rescalePan(
        from current: CGFloat, to next: CGFloat, context: CanvasZoomContext
    ) {
        guard current > 0 else { return }
        let ratio = next / current
        let raw = CGSize(width: panOffset.width * ratio, height: panOffset.height * ratio)
        panOffset = context.clampedPan(raw, at: next)
        basePan = panOffset
    }
}

// MARK: - Wheel-nudge detents

/// Accumulates precise (trackpad) scroll deltas into whole detents for
/// the armed-tool nudge (spec §5.0: plain wheel at fit nudges ±1 per
/// detent). Line-based mouse wheels already arrive in detents and pass
/// through; trackpads emit many small precise deltas that accumulate to
/// a threshold per step.
public struct CanvasWheelNudgeAccumulator: Equatable, Sendable {
    /// Precise-delta points per detent. ~12pt of two-finger travel per
    /// step keeps trackpad nudges deliberate without feeling sticky.
    public static let preciseDeltaPerStep: CGFloat = 12

    private var accumulated: CGFloat = 0

    public init() {}

    /// Whole detents represented by this event, consuming any carried
    /// remainder. Line-based events yield at least ±1 step in the
    /// delta's direction.
    public mutating func steps(deltaY: CGFloat, precise: Bool) -> Int {
        if precise {
            accumulated += deltaY
            let whole = (accumulated / Self.preciseDeltaPerStep).rounded(.towardZero)
            guard whole != 0 else { return 0 }
            accumulated -= whole * Self.preciseDeltaPerStep
            return Int(whole)
        }
        guard deltaY != 0 else { return 0 }
        let magnitude = max(1, Int(abs(deltaY).rounded()))
        return deltaY > 0 ? magnitude : -magnitude
    }

    /// Drop any carried remainder (e.g. when the armed tool changes).
    public mutating func reset() {
        accumulated = 0
    }
}
