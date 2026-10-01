import Foundation

/// Immutable, source-bound accepted stack. Rust owns record validation and
/// schema dispatch; Swift retains the exact JSON for snapshots and CAS saves.
/// Construction is cold work. Model equality/hash never parses JSON or calls FFI.
public struct RemovalRecords: Codable, Hashable, Sendable {
  public let json: String
  public let isEmpty: Bool

  public init(json: String) throws {
    _ = try RemovalBridge.assetNames(records: json)
    guard let records = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [Any] else {
      throw RemovalError.invalid("Removal records must be an array")
    }
    self.json = json
    self.isEmpty = records.isEmpty
  }

  public init(from decoder: Decoder) throws {
    try self.init(json: decoder.singleValueContainer().decode(String.self))
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(json)
  }
}
