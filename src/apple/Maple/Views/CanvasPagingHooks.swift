// CanvasPagingHooks.swift — what a pager hosting `CanvasZoomHost` hears of its
// drags (#5762): each frame with the part the photo's pan did not take, and
// the release with where a flick would carry it.

import CoreGraphics

struct CanvasPagingHooks {
  struct Frame {
    /// In global space, so a canvas moved by the pull-down reads the finger.
    let translation: CGSize
    /// The horizontal drag the photo's pan did not take (`CanvasDragOverflow`).
    let unabsorbed: CGFloat
    let isZoomedIn: Bool
    /// Two fingers on the canvas are a pinch, never a pull.
    let isPinching: Bool
  }

  struct Release {
    let frame: Frame
    /// `unabsorbed` plus the flick's predicted further travel.
    let predictedUnabsorbed: CGFloat
    let velocity: CGSize
    /// The photo's rect at rest, in the canvas's own coordinates.
    let shownRect: CGRect?
  }

  var changed: (Frame) -> Void
  var ended: (Release) -> Void
  /// The drag ended without a release (a system gesture took the touch).
  var cancelled: () -> Void
}
