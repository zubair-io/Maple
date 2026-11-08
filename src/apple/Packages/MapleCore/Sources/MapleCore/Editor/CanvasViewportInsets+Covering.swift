// CanvasViewportInsets+Covering.swift — the canvas's visible area from the
// chrome floating over it (docs/zoom.md § Visible area).
//
// The editor draws the photo beneath its header, inspector, dock and
// filmstrip, and on iPad and the Mac beneath the status bar too. Fit and the
// centred position must use only what the user can see, so the host measures
// each covering surface and turns them into edge insets here.

import CoreGraphics

extension CanvasViewportInsets {
  /// Insets of `viewport` left by `safeArea` (the region clear of the system
  /// bars, `nil` when the canvas already sits inside it) and the chrome
  /// `frames`, all in one coordinate space. Each frame is attributed to the
  /// single edge whose inset removes it from the visible area at the least
  /// cost — a header to the top, a side inspector to its side, a dock to the
  /// bottom — and each edge keeps the largest inset any frame asks of it.
  /// Frames outside the viewport are ignored.
  public static func covering(
    viewport: CGRect, safeArea: CGRect?, frames: [CGRect]
  ) -> CanvasViewportInsets {
    guard viewport.width > 0, viewport.height > 0 else { return .zero }
    let safe = safeArea.map { viewport.intersection($0) }.flatMap { $0.isNull ? nil : $0 }
    let base = CanvasViewportInsets(
      top: max(0, (safe?.minY ?? viewport.minY) - viewport.minY),
      left: max(0, (safe?.minX ?? viewport.minX) - viewport.minX),
      bottom: max(0, viewport.maxY - (safe?.maxY ?? viewport.maxY)),
      right: max(0, viewport.maxX - (safe?.maxX ?? viewport.maxX)))
    return frames.reduce(base) { insets, frame in
      insets.covering(viewport.intersection(frame), in: viewport)
    }
  }

  private func covering(_ frame: CGRect, in viewport: CGRect) -> CanvasViewportInsets {
    guard !frame.isNull, frame.width > 0, frame.height > 0 else { return self }
    let top = frame.maxY - viewport.minY
    let bottom = viewport.maxY - frame.minY
    let left = frame.maxX - viewport.minX
    let right = viewport.maxX - frame.minX
    let cheapest = [
      (top * viewport.width, Edge.top), (bottom * viewport.width, .bottom),
      (left * viewport.height, .left), (right * viewport.height, .right),
    ].min { $0.0 < $1.0 }?.1
    switch cheapest {
    case .top: return with(top: max(self.top, top))
    case .bottom: return with(bottom: max(self.bottom, bottom))
    case .left: return with(left: max(self.left, left))
    case .right: return with(right: max(self.right, right))
    case nil: return self
    }
  }

  private enum Edge { case top, bottom, left, right }

  private func with(
    top: CGFloat? = nil, left: CGFloat? = nil, bottom: CGFloat? = nil, right: CGFloat? = nil
  ) -> CanvasViewportInsets {
    CanvasViewportInsets(
      top: top ?? self.top, left: left ?? self.left, bottom: bottom ?? self.bottom,
      right: right ?? self.right)
  }
}
