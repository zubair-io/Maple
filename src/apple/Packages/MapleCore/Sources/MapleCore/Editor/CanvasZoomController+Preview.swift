// CanvasZoomController+Preview.swift — what Preview needs from the shared
// canvas zoom (#5762): a held-back render, the drag a pan at the photo's edge
// hands to paging, and the photo's rect on screen for the pull-down hero.

import CoreGraphics
import Foundation

extension CanvasZoomController {
  func pushViewportToSession() {
    guard rendersSession, viewportPoints != .zero else { return }
    session.previewSize = context.viewportPx
  }

  /// Let zoom and viewport changes reach the session from now on, and push
  /// the current ones, which starts its render.
  public func startRenderingSession() {
    guard !rendersSession else { return }
    rendersSession = true
    pushViewportToSession()
    commitToSession()
  }

  /// Hold zoom and viewport changes back from the session again, while
  /// another surface (the editor pushed over Preview) drives it.
  public func stopRenderingSession() {
    rendersSession = false
  }

  /// Whether the photo at rest is zoomed in past a still of
  /// `stillLongEdgePixels` (`PreviewCanvasRender`).
  public func showsMoreThanStill(ofLongEdge stillLongEdgePixels: CGFloat) -> Bool {
    guard let size = displayFrameInPoints else { return false }
    return PreviewCanvasRender.shouldRender(
      isZoomedIn: isZoomedIn,
      shownLongEdgePixels: max(size.width, size.height) * displayScale,
      stillLongEdgePixels: stillLongEdgePixels)
  }

  /// A drag frame that also records, in `overflow`, the part of the drag the
  /// photo's pan did not take.
  public func dragChanged(translation: CGSize, tracking overflow: inout CanvasDragOverflow) {
    let panBefore = panOffset.width
    let pinching = model.pinchStartScale != nil
    dragChanged(translation: translation)
    overflow.track(
      translation: translation.width, panMoved: panOffset.width - panBefore, counts: !pinching)
  }

  /// The photo's rect at rest, in the coordinates of `frame`, the viewport's
  /// frame. `nil` before an extent is known.
  public func shownRect(inViewport frame: CGRect) -> CGRect? {
    guard let size = displayFrameInPoints, size.width > 0, size.height > 0 else { return nil }
    let center = CGPoint(x: frame.midX + panOffset.width, y: frame.midY + panOffset.height)
    return CGRect(
      x: center.x - size.width / 2, y: center.y - size.height / 2,
      width: size.width, height: size.height)
  }
}

/// The horizontal part of one drag that the photo's pan did not take: all of
/// it when the photo cannot pan, else what is left once its edge reached the
/// viewport's. Positive is a drag to the right. Summed frame by frame, so a
/// geometry change mid-drag (a sharper still landing, a rotation), which
/// re-bases the zoom model's own drag, never jumps it.
public struct CanvasDragOverflow: Equatable, Sendable {
  public private(set) var horizontal: CGFloat = 0
  private var lastTranslation: CGFloat = 0

  public init() {}

  /// `counts` is false for travel that is not a pan or a page swipe: a
  /// pinch's fingers, a lingering finger just after a pinch.
  public mutating func track(translation: CGFloat, panMoved: CGFloat, counts: Bool) {
    defer { lastTranslation = translation }
    guard counts else { return }
    horizontal += translation - lastTranslation - panMoved
  }
}
