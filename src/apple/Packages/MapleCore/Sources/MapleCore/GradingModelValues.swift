import Foundation

// Missing new keys in a pre-upgrade durable transfer use the model defaults.
// Explicit values keep the existing flat JSON representation.

@propertyWrapper
public struct ColorGradeBlendingValue: Codable, Hashable, Sendable {
  public var wrappedValue: Double
  public init(wrappedValue: Double) { self.wrappedValue = wrappedValue }
  public init(from decoder: Decoder) throws {
    wrappedValue = try decoder.singleValueContainer().decode(Double.self)
  }
  public func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    try value.encode(wrappedValue)
  }
}

@propertyWrapper
public struct ColorGradeEdgeValue: Codable, Hashable, Sendable {
  public var wrappedValue: Double
  public init(wrappedValue: Double) { self.wrappedValue = wrappedValue }
  public init(from decoder: Decoder) throws {
    wrappedValue = try decoder.singleValueContainer().decode(Double.self)
  }
  public func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    try value.encode(wrappedValue)
  }
}

@propertyWrapper
public struct ColorCurveValue: Codable, Hashable, Sendable {
  public var wrappedValue: ToneCurve
  public init(wrappedValue: ToneCurve) { self.wrappedValue = wrappedValue }
  public init(from decoder: Decoder) throws {
    wrappedValue = try decoder.singleValueContainer().decode(ToneCurve.self)
  }
  public func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    try value.encode(wrappedValue)
  }
}

extension KeyedDecodingContainer {
  func decode(_ type: ColorGradeBlendingValue.Type, forKey key: Key) throws
    -> ColorGradeBlendingValue
  {
    try decodeIfPresent(type, forKey: key)
      ?? ColorGradeBlendingValue(wrappedValue: AdjustmentModel.default.colorGradeBlending)
  }
  func decode(_ type: ColorGradeEdgeValue.Type, forKey key: Key) throws -> ColorGradeEdgeValue {
    try decodeIfPresent(type, forKey: key)
      ?? ColorGradeEdgeValue(wrappedValue: ColorGradeZoneEdge.anchor)
  }
  func decode(_ type: ColorCurveValue.Type, forKey key: Key) throws -> ColorCurveValue {
    try decodeIfPresent(type, forKey: key) ?? ColorCurveValue(wrappedValue: ToneCurve.identity)
  }
}
