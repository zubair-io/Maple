// CanvasZoomModel.swift — zoom/pan/gesture state machine (#1099, #5710).
//
// A thin Swift face over the shared Rust model (`raw_core::canvas`, #5714):
// every transition hands the current state to `maple_canvas_zoom_*` and adopts
// the state it returns, so the fit/fill/100% detents, the 0.5×fit … 8 range,
// pinch snapping, double-tap and badge cycles, anchor-preserving zoom and the
// resize re-centring rules are one implementation across platforms
// (docs/zoom.md). The Swift side only converts CoreGraphics values and maps
// the C codes onto Swift enums.
//
// Gesture arbitration (spec §5.0 table) is exposed as intents
// (`dragIntent(context:)`, `wheelIntent(commandHeld:context:)`) so hosts
// route inputs without re-deriving the pannable-vs-editing rule.

import CoreGraphics
import Foundation
import RawPipeline

// MARK: - Context

/// Points of the canvas viewport that the host's chrome covers from each
/// edge (header, inspector, filmstrip, safe-area insets). Left and right are
/// in the viewport's own coordinate space, not leading/trailing.
public struct CanvasViewportInsets: Equatable, Sendable {
  public let top: CGFloat
  public let left: CGFloat
  public let bottom: CGFloat
  public let right: CGFloat

  public static let zero = CanvasViewportInsets(top: 0, left: 0, bottom: 0, right: 0)

  public init(top: CGFloat, left: CGFloat, bottom: CGFloat, right: CGFloat) {
    self.top = top
    self.left = left
    self.bottom = bottom
    self.right = right
  }

  init(_ insets: MapleCanvasInsets) {
    self.init(
      top: CGFloat(insets.top), left: CGFloat(insets.left), bottom: CGFloat(insets.bottom),
      right: CGFloat(insets.right))
  }

  var ffi: MapleCanvasInsets {
    MapleCanvasInsets(
      top: Double(top), left: Double(left), bottom: Double(bottom), right: Double(right))
  }
}

/// Immutable per-call geometry the zoom transitions resolve against: the live
/// viewport (points), the trustworthy image extent (oriented source pixels,
/// `.zero` until known), the points→real-pixels factor and the chrome insets.
/// The image is drawn across the whole viewport, but fit, fill and the
/// centred position resolve inside the visible area the insets leave. Stored
/// exactly as Rust sanitizes it (non-finite or negative sizes → `.zero`,
/// display scale ≥ 0.001, insets that leave no room dropped).
public struct CanvasZoomContext: Equatable, Sendable {
  public let viewportPoints: CGSize
  public let nativeImageSize: CGSize
  public let displayScale: CGFloat
  public let insets: CanvasViewportInsets

  public init(
    viewportPoints: CGSize, nativeImageSize: CGSize, displayScale: CGFloat,
    insets: CanvasViewportInsets = .zero
  ) {
    let sanitized = maple_canvas_zoom_context_sanitize(
      MapleCanvasZoomContext(
        viewport_points: MapleCanvasSize(viewportPoints),
        native_image_size: MapleCanvasSize(nativeImageSize),
        display_scale: Double(displayScale),
        insets: insets.ffi
      ))
    self.viewportPoints = CGSize(sanitized.viewport_points)
    self.nativeImageSize = CGSize(sanitized.native_image_size)
    self.displayScale = CGFloat(sanitized.display_scale)
    self.insets = CanvasViewportInsets(sanitized.insets)
  }

  var ffi: MapleCanvasZoomContext {
    MapleCanvasZoomContext(
      viewport_points: MapleCanvasSize(viewportPoints),
      native_image_size: MapleCanvasSize(nativeImageSize),
      display_scale: Double(displayScale),
      insets: insets.ffi
    )
  }

  /// Viewport in REAL screen pixels — what the render pipeline targets.
  public var viewportPx: CGSize { CGSize(maple_canvas_zoom_viewport_px(ffi)) }

  /// `CanvasMath` snapshot for a given user-intent scale + pan. Fit (`0`)
  /// resolves to the visible-area fit first.
  public func canvasMath(pixelScale: CGFloat, panOffset: CGSize = .zero) -> CanvasMath {
    CanvasMath(
      viewportPx: viewportPx,
      nativeImageSize: nativeImageSize,
      pixelScale: effectiveScale(for: pixelScale),
      panOffset: panOffset,
      displayScale: displayScale
    )
  }

  /// Scale at which the image fits the visible area.
  public var fitScale: CGFloat { CGFloat(maple_canvas_zoom_fit_scale(ffi)) }

  /// Scale at which the image covers the visible area, capped at
  /// `max(maxPixelScale, 8 × fit)`: a sliver image cannot ask for an unbounded
  /// zoom, and a tiny one still fills the visible area.
  public var fillScale: CGFloat { CGFloat(maple_canvas_zoom_fill_scale(ffi)) }

  /// Smallest legal scale: `fit × minFitFraction`.
  public var minScale: CGFloat { CGFloat(maple_canvas_zoom_min_scale(ffi)) }

  /// The pan that centres the image in the visible area.
  public var homePan: CGSize { CGSize(maple_canvas_zoom_home_pan(ffi)) }

  /// Resolves the `0 == fit` sentinel into a concrete scale.
  public func effectiveScale(for pixelScale: CGFloat) -> CGFloat {
    CGFloat(maple_canvas_zoom_effective_scale(ffi, Double(pixelScale)))
  }

  /// On-screen frame (points) at `pixelScale`; nil until the size is known.
  public func displayFrameInPoints(at pixelScale: CGFloat) -> CGSize? {
    canvasMath(pixelScale: pixelScale).displayFrameInPoints
  }

  /// Largest pan (points, per axis) away from `homePan` that keeps the image
  /// covering the visible area; zero on an axis where it does not overflow.
  public func maxPanOffset(at pixelScale: CGFloat) -> CGSize {
    CGSize(maple_canvas_zoom_max_pan_offset(ffi, Double(pixelScale)))
  }

  /// Clamp a pan offset into the resting range at `pixelScale`.
  public func clampedPan(_ pan: CGSize, at pixelScale: CGFloat) -> CGSize {
    CGSize(maple_canvas_zoom_clamped_pan(ffi, MapleCanvasSize(pan), Double(pixelScale)))
  }
}

// MARK: - Model

public struct CanvasZoomModel: Equatable, Sendable {
  // MARK: State (mirrors `raw_core::canvas::CanvasZoomModel`)

  /// User-intent pixel scale: 0 = fit, 1 = 100%, ≤ `max(maxPixelScale, fit, fill)`.
  public internal(set) var pixelScale: CGFloat = 0
  /// Pan offset in points. Positive = image dragged right/down.
  public internal(set) var panOffset: CGSize = .zero
  /// Pan committed at the end of the last drag.
  public internal(set) var basePan: CGSize = .zero
  /// Drag translation recorded while a pinch suppressed the drag, so a
  /// post-pinch drag measures from here instead of jumping.
  public internal(set) var dragTranslationBase: CGSize?
  /// Scale captured at pinch start; non-nil while a pinch is live.
  public internal(set) var pinchStartScale: CGFloat?
  public internal(set) var pinchStartPan: CGSize = .zero
  public internal(set) var pinchStartCentroid: CGPoint = .zero
  public internal(set) var pinchLastCentroid: CGPoint = .zero
  /// Magnification at the pinch capture; the pinch scales by the ratio of
  /// the live magnification to it.
  public internal(set) var pinchStartMagnification: CGFloat = 0
  /// Latest pinch magnification: with `pinchLastCentroid`, the live input.
  public internal(set) var pinchLastMagnification: CGFloat = 0
  /// Latest cumulative translation of a live drag.
  public internal(set) var dragLastTranslation: CGSize?
  /// True while the zoom is the fill stop (re-resolved on resize).
  public internal(set) var fillsViewport = false

  public init() {}

  // MARK: Constants (single-sourced from raw-core)

  /// Upper clamp on `pixelScale` — 8× (800%), raised to fit or fill when
  /// either exceeds it (#5714).
  public static let maxPixelScale = CGFloat(maple_canvas_constants().max_pixel_scale)
  /// Floor for explicit zoom targets so a programmatic 0 can't re-enter fit.
  public static let minExplicitZoom = CGFloat(maple_canvas_constants().min_explicit_zoom)
  /// ⌘= / ⌘- step.
  public static let zoomStep = CGFloat(maple_canvas_constants().zoom_step)
  /// Detent band as a fraction of a stop's scale.
  public static let detentTolerance = CGFloat(maple_canvas_constants().detent_tolerance)
  /// Zoom-out floor as a fraction of fit.
  public static let minFitFraction = CGFloat(maple_canvas_constants().min_fit_fraction)
  /// Cmd+scroll zoom: scale multiplies by `exp2(normalizedDeltaY × this)`.
  public static let wheelZoomSensitivity = CGFloat(maple_canvas_constants().wheel_zoom_sensitivity)

  // MARK: Arbitration intents (spec §5.0 table)

  /// True when the user has explicitly zoomed (`pixelScale != 0`).
  public var isZoomedIn: Bool { pixelScale > 0 }

  /// True when the image overflows the viewport on some axis.
  public func canPan(context: CanvasZoomContext) -> Bool {
    dragIntent(context: context) == .pan
  }

  /// Where a one-finger / mouse drag on the canvas routes.
  public enum DragIntent: Equatable, Sendable {
    /// Nothing to pan (fit or below) — the drag belongs to the editing surface.
    case editing
    /// The image overflows the viewport — the drag pans it.
    case pan
  }

  public func dragIntent(context: CanvasZoomContext) -> DragIntent {
    maple_canvas_zoom_drag_intent(ffi, context.ffi) == UInt32(MAPLE_CANVAS_DRAG_INTENT_PAN)
      ? .pan : .editing
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
    switch maple_canvas_zoom_wheel_intent(ffi, commandHeld ? 1 : 0, context.ffi) {
    case UInt32(MAPLE_CANVAS_WHEEL_INTENT_ZOOM): return .zoom
    case UInt32(MAPLE_CANVAS_WHEEL_INTENT_PAN): return .pan
    default: return .editing
    }
  }

  /// Double-tap / double-click behavior, configured per surface.
  public enum DoubleTapBehavior: Equatable, Sendable {
    /// Legacy full-image surface: always return to fit.
    case resetToFit
    /// S5 editor (spec §5.0): fit ↔ 100% toggle.
    case toggleFitAnd100
  }

  // MARK: Transitions

  /// Per-frame pinch update; the first frame captures the start scale, pan
  /// and centroid, and later frames derive from them (cumulative
  /// magnification can't compound).
  public mutating func pinchChanged(
    magnification: CGFloat,
    location: CGPoint,
    context: CanvasZoomContext
  ) {
    adopt(
      maple_canvas_zoom_pinch_changed(
        ffi, Double(magnification), MapleCanvasPoint(location), context.ffi))
  }

  /// The fingers of a live pinch changed (one lifted or landed): re-anchor so
  /// `magnification` at `location` reproduces the frame shown at
  /// `shownMagnification` about `shownLocation`, instead of jumping to the
  /// new centroid (#5732).
  public mutating func pinchRebased(
    shownMagnification: CGFloat,
    shownLocation: CGPoint,
    magnification: CGFloat,
    location: CGPoint,
    context: CanvasZoomContext
  ) {
    adopt(
      maple_canvas_zoom_pinch_rebased(
        ffi, Double(shownMagnification), MapleCanvasPoint(shownLocation),
        Double(magnification), MapleCanvasPoint(location), context.ffi))
  }

  /// Pinch release: commit the final scale and clear the start capture, then
  /// settle — below fit or inside fit's band onto fit centred in the visible
  /// area, inside fill's band onto fill, otherwise into the resting pan range.
  public mutating func pinchEnded(magnification: CGFloat, context: CanvasZoomContext) {
    adopt(maple_canvas_zoom_pinch_ended(ffi, Double(magnification), context.ffi))
  }

  /// Per-frame drag update. Returns `true` when consumed as a pan.
  @discardableResult
  public mutating func dragChanged(translation: CGSize, context: CanvasZoomContext) -> Bool {
    let result = maple_canvas_zoom_drag_changed(ffi, MapleCanvasSize(translation), context.ffi)
    adopt(result.state)
    return result.handled
  }

  /// Drag release. Returns `true` when a pan was committed (callers push the
  /// new visible rect on commit).
  @discardableResult
  public mutating func dragEnded() -> Bool {
    let result = maple_canvas_zoom_drag_ended(ffi)
    adopt(result.state)
    return result.handled
  }

  /// Track the drag's running translation WITHOUT panning (post-pinch
  /// cooldown), so a continued pan resumes with no accumulated jump.
  public mutating func rebaseDragBaseline(_ translation: CGSize) {
    adopt(maple_canvas_zoom_rebase_drag_baseline(ffi, MapleCanvasSize(translation)))
  }

  /// Two-finger scroll / wheel pan while zoomed in (points).
  public mutating func wheelPan(by delta: CGSize, context: CanvasZoomContext) {
    adopt(maple_canvas_zoom_wheel_pan(ffi, MapleCanvasSize(delta), context.ffi))
  }

  /// Cmd+scroll zoom anchored at the cursor; positive zooms in.
  public mutating func wheelZoom(
    normalizedDeltaY: CGFloat,
    location: CGPoint,
    context: CanvasZoomContext
  ) {
    adopt(
      maple_canvas_zoom_wheel_zoom(
        ffi, Double(normalizedDeltaY), MapleCanvasPoint(location), context.ffi))
  }

  /// Double-tap / double-click per the configured behavior.
  public mutating func doubleTap(
    at location: CGPoint,
    behavior: DoubleTapBehavior,
    context: CanvasZoomContext
  ) {
    let code =
      behavior == .toggleFitAnd100
      ? MAPLE_CANVAS_DOUBLE_TAP_TOGGLE_FIT_AND_100 : MAPLE_CANVAS_DOUBLE_TAP_RESET_TO_FIT
    adopt(
      maple_canvas_zoom_double_tap(ffi, MapleCanvasPoint(location), UInt32(code), context.ffi))
  }

  /// Rest at the frame an interrupted settle was showing, held to the zoom
  /// range and inside the visible area; ignored for an undrawable frame or
  /// before the image size is known.
  public mutating func holdShown(_ frame: CanvasShownFrame, context: CanvasZoomContext) {
    adopt(
      maple_canvas_zoom_hold_shown(
        ffi, Double(frame.scale), MapleCanvasSize(frame.pan), context.ffi))
  }

  /// Back to fit mode: `pixelScale = 0`, centred in the visible area; a live
  /// pinch or drag continues from fit.
  public mutating func resetToFit(context: CanvasZoomContext) {
    adopt(maple_canvas_zoom_reset_to_fit(ffi, context.ffi))
  }

  /// Explicit zoom target (toolbar "100%", ⌘1): clamped, re-centred in the
  /// visible area.
  public mutating func zoomToScale(_ scale: CGFloat, context: CanvasZoomContext) {
    adopt(maple_canvas_zoom_to_scale(ffi, Double(scale), context.ffi))
  }

  /// ⌘= step, anchored at the visible centre.
  public mutating func stepZoomIn(context: CanvasZoomContext) {
    adopt(maple_canvas_zoom_step_in(ffi, context.ffi))
  }

  /// ⌘- step, anchored at the visible centre; settles on fit when it
  /// reaches it.
  public mutating func stepZoomOut(context: CanvasZoomContext) {
    adopt(maple_canvas_zoom_step_out(ffi, context.ffi))
  }

  /// Re-resolve against fresh geometry when the previous geometry is unknown
  /// (`geometryChanged(from:to:)` carries the zoom when it is): fit re-centres
  /// in the visible area, fill follows it, and any other pan is pulled back
  /// inside range (a pan already inside stays put).
  public mutating func reclampPan(context: CanvasZoomContext) {
    adopt(maple_canvas_zoom_reclamp_pan(ffi, context.ffi))
  }
}
