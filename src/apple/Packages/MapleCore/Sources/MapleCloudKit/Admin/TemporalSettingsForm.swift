// TemporalSettingsForm.swift — editable state for the Temporal section of
// the Workers page (#5826). Mirrors temporal-settings.component.ts.
//
// Kept free of SwiftUI so it can be unit-tested directly, like
// NetworkSettingsForm. Two rules live here: the draft is seeded once and
// never overwritten by a later poll, and a response issued before a save
// cannot land after it.

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

  /// Bumps the generation so every read issued before the save is discarded
  /// when it lands; the returned token is the one the save response carries.
  public mutating func beginSave() -> Int {
    generation += 1
    return generation
  }

  /// Applies a response issued under `token`. The first accepted response
  /// seeds the draft; later ones only refresh the connection readout, so a
  /// poll never clobbers what the operator is typing.
  @discardableResult
  public mutating func adopt(_ next: TemporalSettings, token: Int) -> Bool {
    guard token == generation else { return false }
    if settings == nil {
      address = next.address
      namespace = next.namespace
    }
    settings = next
    return true
  }
}
