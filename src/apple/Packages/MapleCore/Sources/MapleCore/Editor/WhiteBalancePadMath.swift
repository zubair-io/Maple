// WhiteBalancePadMath.swift — pure math for the white-balance pad (#5121).
//
// The pad's x axis is temperature (cool on the left, warm on the right) and
// its y axis is tint (green at the bottom, magenta at the top). The mapping
// is the one `wb-pad-math.ts` uses on web, so the same pair sits at the same
// spot on both pads. Writes go through `ToolValueMapping.apply`, the path
// the Temperature and Tint sliders use, so a pad edit leaves the same
// values and provenance in the sidecar as the equivalent slider edits.

import Foundation

public enum WhiteBalancePadMath {
  /// One arrow-key press, as on web: 100 K, or one tint unit.
  public static let temperatureStep = 100.0
  public static let tintStep = 1.0

  /// Pad fraction (0 = coolest edge, 1 = warmest edge) to whole kelvins.
  public static func temperature(atFraction x: Double) -> Double {
    value(atFraction: x, in: AdjustmentModel.temperatureRange)
  }

  /// Pad fraction (0 = green edge, 1 = magenta edge) to whole tint units.
  public static func tint(atFraction y: Double) -> Double {
    value(atFraction: y, in: AdjustmentModel.tintRange)
  }

  /// Where a temperature sits on the pad. A stored value outside the
  /// range stays on the nearest edge.
  public static func fraction(forTemperature temperature: Double) -> Double {
    fraction(for: temperature, in: AdjustmentModel.temperatureRange)
  }

  /// Where a tint sits on the pad. A stored value outside the range stays
  /// on the nearest edge.
  public static func fraction(forTint tint: Double) -> Double {
    fraction(for: tint, in: AdjustmentModel.tintRange)
  }

  /// `model` with both axes set by hand. Either axis that moves marks the
  /// pair Manual and clears the sample point, as a slider edit does.
  public static func applying(
    temperature: Double, tint: Double, to model: AdjustmentModel
  ) -> AdjustmentModel {
    var next = model
    ToolValueMapping.apply(
      clamp(temperature, to: AdjustmentModel.temperatureRange), to: &next, tool: .temp)
    ToolValueMapping.apply(clamp(tint, to: AdjustmentModel.tintRange), to: &next, tool: .tint)
    return next
  }

  /// `model` nudged by whole key steps. Both axes are clamped on read, so
  /// a stored out-of-range value on the axis that is not stepping is
  /// brought back into range instead of being written back as it was.
  public static func stepping(
    _ model: AdjustmentModel, temperatureSteps: Int = 0, tintSteps: Int = 0
  ) -> AdjustmentModel {
    let temperature = clamp(model.temperature, to: AdjustmentModel.temperatureRange)
    let tint = clamp(model.tint, to: AdjustmentModel.tintRange)
    return applying(
      temperature: temperature + Double(temperatureSteps) * temperatureStep,
      tint: tint + Double(tintSteps) * tintStep, to: model)
  }

  private static func value(atFraction fraction: Double, in range: ClosedRange<Double>) -> Double {
    let clamped = clamp(fraction, to: 0...1)
    return (range.lowerBound + clamped * (range.upperBound - range.lowerBound)).rounded()
  }

  private static func fraction(for value: Double, in range: ClosedRange<Double>) -> Double {
    (clamp(value, to: range) - range.lowerBound) / (range.upperBound - range.lowerBound)
  }

  private static func clamp(_ value: Double, to range: ClosedRange<Double>) -> Double {
    min(max(value, range.lowerBound), range.upperBound)
  }
}
