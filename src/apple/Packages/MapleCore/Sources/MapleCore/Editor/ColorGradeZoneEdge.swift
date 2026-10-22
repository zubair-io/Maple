import Foundation

public enum ColorGradeZoneEdge {
  public static let shadowRange: ClosedRange<Double> = AdjustmentModel.colorGradeShadowEdgeRange
  public static let highlightRange: ClosedRange<Double> = AdjustmentModel
    .colorGradeHighlightEdgeRange

  public static let anchor = shadowRange.upperBound

  /// `x` and `width` must be in the SAME coordinate space: the strip's, not
  /// the dragged handle's, or the pivot tracks the handle's own 22pt frame.
  /// Rounds to 3 decimals and snaps to the anchor within 0.005, as `raw-core`'s
  /// `resolve_*_edge` and the Web and Windows strips do, so a drag to the end
  /// writes the default rather than 0.565.
  public static func normalized(x: Double, width: Double, range: ClosedRange<Double>) -> Double {
    let rounded = (x / max(width, 1) * 1000).rounded() / 1000
    let snapped = abs(rounded - anchor) < 0.005 ? anchor : rounded
    return min(max(snapped, range.lowerBound), range.upperBound)
  }
}
