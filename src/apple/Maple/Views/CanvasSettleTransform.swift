// CanvasSettleTransform.swift — draws the canvas leaf at its live gesture
// transform plus any running settle animation (docs/zoom.md § Pinch release).

import MapleCore
import SwiftUI

/// The leaf's compositor transform: the live iOS pinch zoom and pan, and a
/// settle's transform over the settled frame, both read from the controller
/// (`presentedTransform(at:)`) so overlays draw the same frame. The timeline
/// wraps only the modifier's content placeholder, so a settle re-applies the
/// transform each frame without re-evaluating the leaf's body or updating
/// its GPU view.
struct CanvasSettleTransform: ViewModifier {
  let controller: CanvasZoomController

  func body(content: Content) -> some View {
    TimelineView(.animation(paused: !controller.isPresentationAnimating)) { timeline in
      let shown = controller.presentedTransform(at: timeline.date)
      content
        .scaleEffect(shown.zoom, anchor: .center)
        .offset(shown.pan)
    }
  }
}
