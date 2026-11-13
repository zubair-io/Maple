// CanvasZoomModel+Geometry.swift — stateless zoom rules (#1099, #1493).
//
// Detents, the zoom-out target, stop cycles and the focal-anchored pan derivations the
// transitions and the iOS compositor pinch rely on, resolved by raw-core
// (`raw_core::canvas`, #5714).

import CoreGraphics
import Foundation
import RawPipeline

extension CanvasZoomModel {

  // MARK: Detents + zoom steps

  /// The fit or fill stop `scale` sits within `detentTolerance` of — the
  /// nearer one when both bands overlap (fit wins a tie); nil outside both.
  public static func detent(for scale: CGFloat, fit: CGFloat, fill: CGFloat) -> ZoomStop? {
    ZoomStop(code: maple_canvas_zoom_detent(Double(scale), Double(fit), Double(fill)))
  }

  /// True when a discrete zoom `current → next` reaches fit's detent band
  /// from the far side, so the step settles on fit instead of jumping over.
  public static func crossesFit(from current: CGFloat, to next: CGFloat, fit: CGFloat) -> Bool {
    maple_canvas_zoom_crosses_fit(Double(current), Double(next), Double(fit))
  }

  /// Outcome of a ⌘- zoom-out step.
  public enum ZoomOutResult: Equatable, Sendable {
    /// Reset to fit mode (pixelScale = 0, pans cleared).
    case snapToFit
    /// Apply this concrete pixelScale.
    case scale(CGFloat)
  }

  /// ⌘- step from `current`: settles on fit when it reaches fit's band from
  /// above, otherwise divides by `zoomStep` down to `fit × minFitFraction`.
  public static func zoomOutTarget(current: CGFloat, fit: CGFloat) -> ZoomOutResult {
    let target = maple_canvas_zoom_out_target(Double(current), Double(fit))
    return target.snap_to_fit ? .snapToFit : .scale(CGFloat(target.scale))
  }

  // MARK: Zoom stops

  /// The named zoom levels the badge cycles through.
  public enum ZoomStop: Equatable, Sendable {
    case fit
    /// The image covers the whole viewport (no letterbox).
    case fill
    /// 100% — one image pixel per real screen pixel.
    case actualSize
  }

  /// The cycle `fit → fill → 100%` without stops within the detent band of
  /// an earlier one. `actualSize` is the 100% stop's scale, or nil on a
  /// surface without one.
  public static func distinctStops(
    fit: CGFloat, fill: CGFloat, actualSize: CGFloat?
  ) -> [ZoomStop] {
    maple_canvas_zoom_distinct_stops(
      Double(fit), Double(fill), actualSize == nil ? 0 : 1, Double(actualSize ?? 0)
    ).zoomStops
  }

  /// The stop after `current` in `stops` (at most three), wrapping; a free
  /// scale returns to fit.
  public static func nextStop(after current: ZoomStop?, in stops: [ZoomStop]) -> ZoomStop {
    ZoomStop(code: maple_canvas_zoom_next_stop(current.code, MapleCanvasZoomStops(stops)))
      ?? .fit
  }

  // MARK: Focal-anchored pan

  /// Pan that keeps the image point under `anchor` (viewport points) fixed
  /// across `startScale → newScale`:
  /// `p₁ = (q − C) − ((q − C) − p₀)·(s₁/s₀)`.
  public static func anchoredPan(
    anchor: CGPoint,
    viewportPoints: CGSize,
    startPan: CGSize,
    startScale: CGFloat,
    newScale: CGFloat
  ) -> CGSize {
    CGSize(
      maple_canvas_zoom_anchored_pan(
        MapleCanvasPoint(anchor), MapleCanvasSize(viewportPoints), MapleCanvasSize(startPan),
        Double(startScale), Double(newScale)))
  }

}
