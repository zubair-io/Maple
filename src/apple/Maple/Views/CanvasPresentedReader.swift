// CanvasPresentedReader.swift — gives a canvas overlay the photo's on-screen
// geometry every display frame (#5743, #5744).
//
// Overlays are siblings of `CanvasZoomHost`, laid out in the same viewport.
// They place themselves from `presentedGeometry(at:)`, the transform the leaf
// is drawn with, so a live pinch, a settle animation or a commanded zoom
// moves them in the same frame as the photo. The timeline only runs while a
// settle animates; a pinch frame updates the controller, which redraws
// readers directly.

import MapleCore
import SwiftUI

struct CanvasPresentedReader<Content: View>: View {
  let controller: CanvasZoomController
  @ViewBuilder let content: (CanvasPresentedGeometry?) -> Content

  var body: some View {
    TimelineView(.animation(paused: !controller.isPresentationAnimating)) { timeline in
      content(controller.presentedGeometry(at: timeline.date))
    }
  }
}

/// Moves an overlay laid out against the resting frame with the photo:
/// the scale and offset that take the resting frame to the presented one,
/// about the resting frame's centre. For the crop overlay, which is drawn
/// once at the fit footprint by its own layer and never re-laid out per
/// frame; zoom is held at fit while it shows, so this is identity except
/// during a settle onto fit.
struct CanvasPresentedOverlayTransform: ViewModifier {
  let controller: CanvasZoomController

  func body(content: Content) -> some View {
    TimelineView(.animation(paused: !controller.isPresentationAnimating)) { timeline in
      let shown = controller.presentedTransform(at: timeline.date)
      let resting = controller.panOffset
      // Back to the viewport centre, scale about it, out to the shown pan.
      content
        .offset(CGSize(width: -resting.width, height: -resting.height))
        .scaleEffect(shown.zoom, anchor: .center)
        .offset(shown.pan)
    }
  }
}
