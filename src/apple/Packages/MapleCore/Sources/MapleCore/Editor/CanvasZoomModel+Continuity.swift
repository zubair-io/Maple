// CanvasZoomModel+Continuity.swift — the transitions that keep a live pinch
// or drag continuous across what is not finger motion (docs/zoom.md
// § Continuity, #5717). The rules live in raw-core (`zoom_continuity.rs`).

import CoreGraphics
import Foundation
import RawPipeline

extension CanvasZoomModel {
  /// The geometry changed (viewport, chrome insets, display scale, or a
  /// different extent such as a crop): the zoom carries across — 100% stays
  /// 1:1, the image point at the viewport centre stays there — and a live
  /// pinch or drag continues from the frame on screen (#5736, #5740).
  public mutating func geometryChanged(
    from previous: CanvasZoomContext, to context: CanvasZoomContext
  ) {
    adopt(maple_canvas_zoom_geometry_changed(ffi, previous.ffi, context.ffi))
  }

  /// The picture's real extent replaced a provisional one: the photo keeps
  /// its rect on screen exactly, at rest and mid-gesture (#5736).
  public mutating func imageExtentResolved(
    from provisional: CanvasZoomContext, to context: CanvasZoomContext
  ) {
    adopt(maple_canvas_zoom_image_extent_resolved(ffi, provisional.ffi, context.ffi))
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

  /// The pinch was cancelled: it ends at its last input and settles; a live
  /// drag continues from the result.
  public mutating func pinchCancelled(context: CanvasZoomContext) {
    adopt(maple_canvas_zoom_pinch_cancelled(ffi, context.ffi))
  }

  /// The drag was cancelled: it commits where it is; a live pinch stays live.
  public mutating func dragCancelled() {
    adopt(maple_canvas_zoom_drag_cancelled(ffi))
  }
}
