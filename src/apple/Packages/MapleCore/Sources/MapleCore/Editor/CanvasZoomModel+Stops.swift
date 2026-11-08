// CanvasZoomModel+Stops.swift — the named zoom stops (#5710).
//
// Fit, fill and 100% are the three levels a user reaches deliberately: the
// zoom badge cycles them in that order. A pinch released inside a fit or
// fill detent band settles there. Resolved by raw-core (#5714).

import CoreGraphics
import Foundation
import RawPipeline

extension CanvasZoomModel {

  /// The named stop the current zoom sits on, or `nil` for a free scale.
  public var currentStop: ZoomStop? {
    ZoomStop(code: maple_canvas_zoom_current_stop(ffi))
  }

  /// The badge's cycle for this geometry: `fit → fill → 100%`, without
  /// stops that coincide.
  public static func badgeStops(context: CanvasZoomContext) -> [ZoomStop] {
    maple_canvas_zoom_badge_stops(context.ffi).zoomStops
  }

  /// Fill: the image covers the visible area, centred in it. The overflowing
  /// axis can then be panned.
  public mutating func zoomToFill(context: CanvasZoomContext) {
    adopt(maple_canvas_zoom_to_fill(ffi, context.ffi))
  }

  /// Badge tap: advance to the next stop in `fit → fill → 100%`. A free
  /// scale (pinched, stepped, below fit) returns to fit.
  public mutating func advanceStop(context: CanvasZoomContext) {
    adopt(maple_canvas_zoom_advance_stop(ffi, context.ffi))
  }
}
