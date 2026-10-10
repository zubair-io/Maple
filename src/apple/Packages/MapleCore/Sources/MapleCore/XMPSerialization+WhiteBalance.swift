import Foundation

extension XMPSerializer {
  /// Omitted axes remain omitted after unrelated edits; a genuine WB author clears
  /// import state and writes the authoritative pair, including explicit defaults.
  static func whiteBalanceAttrs(_ model: AdjustmentModel) -> [(String, String)] {
    let imported = model.partialWhiteBalance
    let temperature =
      imported == nil ? (model.temperatureSeen ? model.temperature : nil) : imported?.temperature
    let tint = imported == nil ? (model.tintSeen ? model.tint : nil) : imported?.tint
    let version = imported?.version ?? (model.wbScaleVersion == 1 ? 1 : 5)
    return [("crs:WhiteBalance", model.whiteBalancePreset.rawValue)]
      + (temperature.map { [("crs:Temperature", fmtNum($0))] } ?? [])
      + (tint.map { [("crs:Tint", fmtNum($0))] } ?? [])
      + (temperature != nil || tint != nil ? [("papp:WbScaleVersion", String(version))] : [])
  }
}
