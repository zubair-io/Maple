// PrecisionInput.swift — what is pointing at a precision control (#5121).
//
// The tone-curve plot decides, on press, whether to grab an existing point
// or add a new one. A fingertip needs a generous grab area; an Apple Pencil
// tip or a pointer can address points that sit close together. The decision
// is made once here, so a hover preview and the press that follows agree.

import Foundation

public enum PrecisionInputKind: Sendable, Equatable {
  case finger
  case pencil
  case pointer

  /// The grab radius a fingertip gets, in points: half of the 44 pt
  /// minimum touch target.
  public static let fingerRadius = 22.0

  /// The grab radius of a Pencil tip or pointer, in curve units. This is
  /// the plot's original radius: about 8 pt on the compact iPhone plot.
  public static let preciseCurveRadius = 0.05

  /// Radius, in curve units, within which a press grabs an existing
  /// tone-curve point on a plot `plotSide` points wide.
  public func curveHitRadius(plotSide: Double) -> Double {
    switch self {
    case .pencil, .pointer:
      return Self.preciseCurveRadius
    case .finger:
      guard plotSide > 0 else { return Self.preciseCurveRadius }
      return max(Self.preciseCurveRadius, Self.fingerRadius / plotSide)
    }
  }
}

/// What a press on the tone-curve plot does.
public enum ToneCurvePress: Equatable, Sendable {
  /// Grabs the existing point at this index of the materialized list.
  case grab(index: Int)
  /// Adds a point here.
  case insert(x: Double, y: Double)
}

extension ToneCurveEditing {
  /// What a press at `(x, y)` does: grab the nearest point within `radius`,
  /// else add a point there. `nil` when it does neither, because a new
  /// point would share its `x` with an existing one.
  public static func press(
    _ points: [ToneCurvePoint], x: Double, y: Double, radius: Double
  ) -> ToneCurvePress? {
    if let index = hitTest(points, x: x, y: y, radius: radius) { return .grab(index: index) }
    let inserted = insert(points, x: x, y: y)
    let px = min(max(x, 0), 1)
    guard inserted.count > materialize(points).count,
      let point = inserted.first(where: { $0.x == px })
    else { return nil }
    return .insert(x: point.x, y: point.y)
  }
}
