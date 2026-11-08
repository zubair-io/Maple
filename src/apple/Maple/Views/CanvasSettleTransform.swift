// CanvasSettleTransform.swift — draws the canvas leaf at its live gesture
// transform plus any running settle animation (docs/zoom.md § Pinch release).

import MapleCore
import SwiftUI

/// The leaf's compositor transform: the live iOS pinch zoom and pan, and a
/// settle's transform over the settled frame. The timeline wraps only the
/// modifier's content placeholder, so a settle re-applies the transform each
/// frame without re-evaluating the leaf's body or updating its GPU view.
struct CanvasSettleTransform: ViewModifier {
  let settle: CanvasSettleAnimation?
  let liveZoom: CGFloat
  let pan: CGSize

  func body(content: Content) -> some View {
    TimelineView(.animation(paused: settle == nil)) { timeline in
      let settling = settle?.transform(at: timeline.date) ?? (zoom: 1, offset: .zero)
      content
        .scaleEffect(liveZoom * settling.zoom, anchor: .center)
        .offset(
          CGSize(
            width: pan.width + settling.offset.width,
            height: pan.height + settling.offset.height))
    }
  }
}
