// CanvasSettleAnimation.swift — the canvas's move from the frame it showed to
// a settled zoom (docs/zoom.md § Pinch release).
//
// Only finger motion moves the photo directly. Anything else that lands the
// zoom somewhere new — a pinch released below fit springing back to fit, a
// detent, the resting pan range, the chrome covering the canvas changing —
// commits the settled state at once and then animates the picture from what
// was on screen. The animation is a pure function of time, so a gesture that
// interrupts it can read exactly what is showing and continue from there
// (`shown(at:)`), instead of from where it was heading.

import CoreGraphics
import Foundation

/// A zoom as drawn: the resolved scale (real pixels per image pixel) and the
/// pan (points from the viewport centre).
public struct CanvasShownFrame: Equatable, Sendable {
  public let scale: CGFloat
  public let pan: CGSize

  public init(scale: CGFloat, pan: CGSize) {
    self.scale = scale
    self.pan = pan
  }
}

/// A deliberate zoom the host animates: the frame shown before it, and a
/// serial so two commands from the same frame are still two moves.
public struct CanvasCommandedMove: Equatable, Sendable {
  public let from: CanvasShownFrame
  public let serial: Int
}

public struct CanvasSettleAnimation: Equatable, Sendable {
  /// Time to settle; the spring is within half a point of rest by then.
  public static let duration: TimeInterval = 0.35
  /// Critically damped spring rate: `(1 + ωt)·e^(−ωt)` is about 0.1% at
  /// `duration`, so ending exactly on the target there is invisible.
  private static let rate: Double = 9 / duration

  public let from: CanvasShownFrame
  public let to: CanvasShownFrame
  public let start: Date

  /// `nil` when there is nothing to animate: the two frames match, or either
  /// is not a drawable frame.
  public init?(from: CanvasShownFrame, to: CanvasShownFrame, start: Date) {
    let drawable = { (frame: CanvasShownFrame) in
      frame.scale.isFinite && frame.scale > 0 && frame.pan.width.isFinite
        && frame.pan.height.isFinite
    }
    guard drawable(from), drawable(to) else { return nil }
    let still =
      abs(from.scale / to.scale - 1) < 1e-4 && abs(from.pan.width - to.pan.width) < 0.25
      && abs(from.pan.height - to.pan.height) < 0.25
    guard !still else { return nil }
    self.from = from
    self.to = to
    self.start = start
  }

  /// Settle progress, 0 at `start` to exactly 1 from `duration` on.
  public func progress(at date: Date) -> CGFloat {
    let elapsed = date.timeIntervalSince(start)
    guard elapsed > 0 else { return 0 }
    guard elapsed < Self.duration else { return 1 }
    let phase = Self.rate * elapsed
    return CGFloat(1 - (1 + phase) * exp(-phase))
  }

  public func isFinished(at date: Date) -> Bool {
    progress(at: date) >= 1
  }

  /// The frame on screen at `date`: the scale eases geometrically (an even
  /// zoom speed at every size) and the pan linearly.
  public func shown(at date: Date) -> CanvasShownFrame {
    let t = progress(at: date)
    let scale = from.scale * pow(to.scale / from.scale, t)
    return CanvasShownFrame(
      scale: scale,
      pan: CGSize(
        width: from.pan.width + (to.pan.width - from.pan.width) * t,
        height: from.pan.height + (to.pan.height - from.pan.height) * t))
  }

  /// The same settle, still running from `start`, after the image's extent
  /// changed under it: scales drawn in the old extent are `factor` times
  /// the new extent's, and it now heads for `settled`.
  public func rescaled(by factor: CGFloat, to settled: CanvasShownFrame) -> CanvasSettleAnimation? {
    CanvasSettleAnimation(
      from: CanvasShownFrame(scale: from.scale * factor, pan: from.pan), to: settled, start: start)
  }

  /// The compositor transform over the settled frame (drawn at `to.scale`
  /// and `to.pan`) that reproduces `shown(at:)`: a scale about the frame's
  /// centre and an extra offset. Identity once finished.
  public func transform(at date: Date) -> (zoom: CGFloat, offset: CGSize) {
    let shown = shown(at: date)
    return (
      shown.scale / to.scale,
      CGSize(width: shown.pan.width - to.pan.width, height: shown.pan.height - to.pan.height)
    )
  }
}
