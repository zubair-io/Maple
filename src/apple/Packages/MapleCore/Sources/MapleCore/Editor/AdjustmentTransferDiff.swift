import Foundation

public struct AdjustmentTransferDifference: Identifiable, Sendable {
  public let id: String
  public let label: String
  public let before: String
  public let after: String
}

public enum AdjustmentTransferDiff {
  /// Compare the real target against this group's actual merge. Codable values
  /// include structured curves/crop and enums, unlike a scalar-only slider map.
  public static func fields(
    group: AdjustmentGroup, before: AdjustmentModel, after: AdjustmentModel
  ) throws -> [AdjustmentTransferDifference] {
    let merged = AdjustmentGroupMerge.merged(before, applying: after, groups: [group])
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    var old =
      try JSONSerialization.jsonObject(with: encoder.encode(before)) as? [String: Any] ?? [:]
    var new =
      try JSONSerialization.jsonObject(with: encoder.encode(merged)) as? [String: Any] ?? [:]
    if group == .whiteBalance {
      if before.wbSource == .asShot {
        old["temperature"] = "As Shot"
        old["tint"] = "As Shot"
      }
      if merged.wbSource == .asShot {
        new["temperature"] = "As Shot"
        new["tint"] = "As Shot"
      }
    }
    return try differences(before: old, after: new)
  }

  /// Optional Codable fields can disappear when reset to their default.
  static func differences(
    before old: [String: Any], after new: [String: Any]
  ) throws -> [AdjustmentTransferDifference] {
    return try Set(old.keys).union(new.keys).sorted().compactMap { key in
      let oldValue = old[key] as? NSObject
      let newValue = new[key] as? NSObject
      guard oldValue != newValue else { return nil }
      return AdjustmentTransferDifference(
        id: key, label: label(key), before: try display(oldValue, key: key),
        after: try display(newValue, key: key))
    }
  }

  private static func display(_ value: NSObject?, key: String) throws -> String {
    guard let value else { return key == "namedWhiteBalancePreset" ? "Custom" : "None" }
    if let text = value as? String { return text.isEmpty ? "None" : text }
    if let number = value as? NSNumber { return number.stringValue }
    let data = try JSONSerialization.data(
      withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
    return String(decoding: data, as: UTF8.self)
  }

  private static func label(_ key: String) -> String {
    switch key {
    case "namedWhiteBalancePreset": return "White balance preset"
    case "wbSource": return "White balance source"
    case "wbScaleVersion": return "White balance scale"
    case "wbSampleX", "wbSampleY": return "Sample location"
    case "wbAlgorithmVersion": return "Sample version"
    default:
      return key.replacingOccurrences(
        of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression
      )
      .replacingOccurrences(of: "nr ", with: "Noise reduction ").capitalized
    }
  }
}
