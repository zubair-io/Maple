// ColorGradeZoneEdge.swift — maps a pointer position inside the tonal-zone
// strip to a Shadow / Highlight edge pivot (#5040).

import Foundation

public enum ColorGradeZoneEdge {
  public static let shadowRange: ClosedRange<Double> = 0.10...0.564622
  public static let highlightRange: ClosedRange<Double> = 0.564622...0.90

  /// `x` and `width` must be in the SAME coordinate space: the strip's, not
  /// the dragged handle's, or the pivot tracks the handle's own 22pt frame.
  public static func normalized(x: Double, width: Double, range: ClosedRange<Double>) -> Double {
    let position = x / max(width, 1)
    return min(max(position, range.lowerBound), range.upperBound)
  }
}
