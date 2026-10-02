import Foundation

/// Older JSON snapshots always serialized both numerical WB components.
/// Keep that meaning when their presence keys are absent; XMP parsing records
/// each component's actual presence instead of turning As Shot into 6500/0.
@propertyWrapper
public struct WhiteBalancePresenceValue: Codable, Hashable, Sendable {
  public var wrappedValue: Bool

  public init(wrappedValue: Bool) { self.wrappedValue = wrappedValue }

  public init(from decoder: Decoder) throws {
    wrappedValue = try decoder.singleValueContainer().decode(Bool.self)
  }

  public func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    try value.encode(wrappedValue)
  }
}

extension KeyedDecodingContainer {
  func decode(_ type: WhiteBalancePresenceValue.Type, forKey key: Key) throws
    -> WhiteBalancePresenceValue
  {
    try decodeIfPresent(type, forKey: key) ?? WhiteBalancePresenceValue(wrappedValue: true)
  }
}
