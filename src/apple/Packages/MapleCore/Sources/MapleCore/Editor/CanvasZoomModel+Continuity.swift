// CanvasZoomModel+Continuity.swift — the transitions that keep a live pinch
// or drag continuous across what is not finger motion (docs/zoom.md
// § Continuity, #5717). The rules live in raw-core (`zoom_continuity.rs`).

import CoreGraphics
import Foundation
import RawPipeline

extension CanvasZoomModel {
  /// The geometry changed (viewport, chrome insets, display scale or image
  /// extent): the zoom carries across — 100% stays 1:1, the image point at
  /// the viewport centre stays there — and a live pinch or drag continues
  /// from the frame on screen (#5736, #5740).
  public mutating func geometryChanged(
    from previous: CanvasZoomContext, to context: CanvasZoomContext
  ) {
    adopt(maple_canvas_zoom_geometry_changed(ffi, previous.ffi, context.ffi))
  }

  /// A new drag gesture began: commit what the previous drag left on screen,
  /// whose release may never have arrived (#5739).
  public mutating func dragBegan() {
    adopt(maple_canvas_zoom_drag_began(ffi))
  }

  /// Record the live pinch input of a host that freezes the committed frame
  /// during a pinch, so other transitions know the frame on screen.
  public mutating func pinchTracked(magnification: CGFloat, location: CGPoint) {
    adopt(maple_canvas_zoom_pinch_tracked(ffi, Double(magnification), MapleCanvasPoint(location)))
  }

  /// A gesture was cancelled: a live pinch ends at its last input, a live
  /// drag commits where it is.
  public mutating func gesturesCancelled(context: CanvasZoomContext) {
    adopt(maple_canvas_zoom_gestures_cancelled(ffi, context.ffi))
  }
}
