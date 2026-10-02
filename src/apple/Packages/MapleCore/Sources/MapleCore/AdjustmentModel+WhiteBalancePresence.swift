import Foundation

extension AdjustmentModel {
  /// A name-only illuminant owns its generated pair. Otherwise an omitted
  /// component of an imported pair belongs to this asset's camera reading.
  var usesAsShotTemperature: Bool {
    !temperatureSeen && (whiteBalancePreset.pair == nil || tintSeen)
  }

  var usesAsShotTint: Bool {
    !tintSeen && (whiteBalancePreset.pair == nil || temperatureSeen)
  }

  func resolvedWhiteBalance(temperature: Double, tint: Double, frame: WbSliderFrame?)
    -> (temperature: Double, tint: Double)
  {
    if let partialWhiteBalance { return partialWhiteBalance.resolved(in: frame) }
    let validFrame = frame.flatMap { $0.isPresent ? $0 : nil }
    return (
      usesAsShotTemperature
        ? validFrame.map { Double($0.sceneCCT) } ?? temperature
        : self.temperature,
      usesAsShotTint ? validFrame.map { Double($0.asShotTint) } ?? tint : self.tint
    )
  }

  /// Hydrate displayed values without turning them into authored XMP numbers.
  func seedingWhiteBalance(temperature: Double?, tint: Double?) -> Self {
    var seeded = self
    if usesAsShotTemperature, let temperature {
      seeded.temperature = temperature
      seeded.temperatureSeen = false
    }
    if usesAsShotTint, let tint {
      seeded.tint = tint
      seeded.tintSeen = false
    }
    seeded.partialWhiteBalance = partialWhiteBalance
    return seeded
  }
}
