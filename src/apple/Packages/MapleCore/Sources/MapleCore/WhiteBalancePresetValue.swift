import Foundation

/// Keeps the named preset's JSON field backward-compatible without duplicating
/// AdjustmentModel's entire field list in a custom CodingKeys enum.
@propertyWrapper
public struct WhiteBalancePresetValue: Codable, Hashable, Sendable {
  public var wrappedValue: WhiteBalancePreset

  public init(wrappedValue: WhiteBalancePreset) {
    self.wrappedValue = wrappedValue
  }

  public init(from decoder: Decoder) throws {
    wrappedValue = try decoder.singleValueContainer().decode(WhiteBalancePreset.self)
  }

  public func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    try value.encode(wrappedValue)
  }
}

extension KeyedDecodingContainer {
  func decode(_ type: WhiteBalancePresetValue.Type, forKey key: Key) throws
    -> WhiteBalancePresetValue
  {
    try decodeIfPresent(type, forKey: key) ?? WhiteBalancePresetValue(wrappedValue: .custom)
  }
}
