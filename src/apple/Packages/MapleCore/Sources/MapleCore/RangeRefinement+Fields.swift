// RangeRefinement+Fields.swift — the colour-range controls the mask panel
// exposes (#362): the five continuous fields as a keyed surface a slider
// row can bind to, raw-core's default coordinates for the enable toggle,
// and the eyedropper's seed merge (`raw_core::RangeRefinement::with_seed`).

import Foundation

/// The five per-layer colour-range sliders, in panel order. Hue itself is
/// seeded by the eyedropper, not dragged.
public enum RangeField: String, CaseIterable, Identifiable, Sendable {
  case hueWidth, chromaMin, lMin, lMax, feather

  public var id: String { rawValue }

  public var label: String {
    switch self {
    case .hueWidth: return "Hue width"
    case .chromaMin: return "Chroma min"
    case .lMin: return "L min"
    case .lMax: return "L max"
    case .feather: return "Feather"
    }
  }

  /// Slider domain. Oklab chroma of a saturated colour tops out near 0.3;
  /// the lightness window and feather are unit fractions; the half-width
  /// is degrees (90° = a full third of the wheel each side).
  public var range: ClosedRange<Double> {
    switch self {
    case .hueWidth: return 1...90
    case .chromaMin: return 0...0.3
    case .lMin, .lMax, .feather: return 0...1
    }
  }
}

extension RangeRefinement {
  /// raw-core's default Color coordinates (55°, 25°, 0.02, 0.15, 0.95,
  /// 0.3 — the same values the skin preset carries), what the enable
  /// toggle arms before the eyedropper re-centres it.
  public static let coreDefault: RangeRefinement = .skinTone

  /// The band centre, in Oklab degrees as the wire carries it.
  public var hueDeg: Double {
    guard case .color(let hue, _, _, _, _, _) = self else { return 0 }
    return hue
  }

  public func value(of field: RangeField) -> Double {
    guard case .color(_, let width, let chromaMin, let lMin, let lMax, let feather) = self
    else { return 0 }
    switch field {
    case .hueWidth: return width
    case .chromaMin: return chromaMin
    case .lMin: return lMin
    case .lMax: return lMax
    case .feather: return feather
    }
  }

  public func with(_ field: RangeField, _ value: Double) -> RangeRefinement {
    guard case .color(let hue, let width, let chromaMin, let lMin, let lMax, let feather) = self
    else { return self }
    return .color(
      hueDeg: hue,
      hueHalfWidthDeg: field == .hueWidth ? value : width,
      chromaMin: field == .chromaMin ? value : chromaMin,
      lMin: field == .lMin ? value : lMin,
      lMax: field == .lMax ? value : lMax,
      feather: field == .feather ? value : feather)
  }

  /// Re-centred on the eyedropper's sample, keeping the band width and
  /// feather — the user's own settings.
  public func seeded(with sample: MaskRangeSample) -> RangeRefinement {
    guard case .color(_, let width, _, _, _, let feather) = self else { return self }
    return .color(
      hueDeg: sample.hueDeg, hueHalfWidthDeg: width, chromaMin: sample.chromaMin,
      lMin: sample.lMin, lMax: sample.lMax, feather: feather)
  }
}
