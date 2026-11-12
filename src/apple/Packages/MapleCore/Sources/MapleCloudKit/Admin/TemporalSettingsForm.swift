// TemporalSettingsForm.swift — editable state for the Temporal section of
// the Workers page (#5826).

import Foundation

public struct TemporalSettingsForm: Equatable, Sendable {
  public private(set) var settings: TemporalSettings?
  public var address: String
  public var namespace: String
  public private(set) var generation: Int

  public init() {
    settings = nil
    address = ""
    namespace = ""
    generation = 0
  }

  public var target: TemporalTarget? {
    TemporalTarget(address: address, namespace: namespace)
  }

  /// Every read issued before the save carries an older token and is
  /// discarded when it lands; the returned token is the save's own.
  public mutating func beginSave() -> Int {
    generation += 1
    return generation
  }

  /// Only the first accepted response seeds the draft, so a poll never
  /// clobbers what the operator is typing.
  public mutating func adopt(_ next: TemporalSettings, token: Int) {
    guard token == generation else { return }
    if settings == nil {
      address = next.address
      namespace = next.namespace
    }
    settings = next
  }
}
