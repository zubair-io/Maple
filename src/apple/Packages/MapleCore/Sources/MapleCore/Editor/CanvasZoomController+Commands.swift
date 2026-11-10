// CanvasZoomController+Commands.swift — the deliberate zooms a toolbar or
// keyboard asks for. Each one animates from the frame shown before it.

import CoreGraphics
import Foundation

extension CanvasZoomController {
  /// Option-arrow pan is discrete, bounded by the same geometry as a drag.
  public func keyboardPan(delta: CGSize) {
    guard model.isZoomedIn else { return }
    command { $0.wheelPan(by: delta, context: context) }
  }

  /// Fit (⌘0).
  public func resetToFit() {
    command { $0.resetToFit(context: context) }
  }

  /// Fill — the image covers the whole viewport.
  public func zoomToFill() {
    command { $0.zoomToFill(context: context) }
  }

  /// Zoom badge: cycle `fit → fill → 100%` (a free scale returns to fit).
  public func advanceZoomStop() {
    command { $0.advanceStop(context: context) }
  }

  /// The badge's next stop, for its accessibility hint.
  public var nextZoomStop: CanvasZoomModel.ZoomStop {
    CanvasZoomModel.nextStop(
      after: model.currentStop, in: CanvasZoomModel.badgeStops(context: context))
  }

  /// 100% (⌘1) — or any explicit scale.
  public func zoomToScale(_ scale: CGFloat) {
    command { $0.zoomToScale(scale, context: context) }
  }

  /// Zoom in one step (⌘=).
  public func stepZoomIn() {
    command { $0.stepZoomIn(context: context) }
  }

  /// Zoom out one step (⌘-).
  public func stepZoomOut() {
    command { $0.stepZoomOut(context: context) }
  }
}
