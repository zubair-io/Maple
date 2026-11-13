// CanvasWheelNudgeAccumulator.swift — scroll deltas → armed-tool nudge detents.
//
// Split out of CanvasZoomModel.swift when the zoom model moved to raw-core
// (#5714): this input accumulator is not zoom geometry.

import CoreGraphics
import Foundation

/// Accumulates precise (trackpad) scroll deltas into whole detents for
/// the armed-tool nudge (spec §5.0: plain wheel at fit nudges ±1 per
/// detent). Line-based mouse wheels already arrive in detents and pass
/// through; trackpads emit many small precise deltas that accumulate to
/// a threshold per step.
public struct CanvasWheelNudgeAccumulator: Equatable, Sendable {
  /// Precise-delta points per detent. ~12pt of two-finger travel per
  /// step keeps trackpad nudges deliberate without feeling sticky.
  public static let preciseDeltaPerStep: CGFloat = 12

  private var accumulated: CGFloat = 0

  public init() {}

  /// Whole detents represented by this event, consuming any carried
  /// remainder. Line-based events yield at least ±1 step in the
  /// delta's direction.
  public mutating func steps(deltaY: CGFloat, precise: Bool) -> Int {
    if precise {
      accumulated += deltaY
      let whole = (accumulated / Self.preciseDeltaPerStep).rounded(.towardZero)
      guard whole != 0 else { return 0 }
      accumulated -= whole * Self.preciseDeltaPerStep
      return Int(whole)
    }
    guard deltaY != 0 else { return 0 }
    let magnitude = max(1, Int(abs(deltaY).rounded()))
    return deltaY > 0 ? magnitude : -magnitude
  }

  /// Drop any carried remainder (e.g. when the armed tool changes).
  public mutating func reset() {
    accumulated = 0
  }
}
