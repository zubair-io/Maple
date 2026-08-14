// NetworkSettingsForm.swift — editable state for the Network page.
//
// Kept free of SwiftUI so it can be unit-tested directly; XCUITest is
// unavailable on the primary dev machine (#2525), so view-level rules
// only get coverage if they live in a plain type like this one.

import Foundation

public struct NetworkSettingsForm: Equatable, Sendable {
  public var ipOverride: String
  public var portOverride: String
  public var enabled: Bool

  public init(ipOverride: String = "", portOverride: String = "", enabled: Bool = false) {
    self.ipOverride = ipOverride
    self.portOverride = portOverride
    self.enabled = enabled
  }

  /// Build the editable form from a resolved config.
  ///
  /// Only `db_override` provenance seeds an override field. Seeding an
  /// auto-detected address would turn it into a manual override on the
  /// next save, pinning the page to a stale DHCP lease.
  public static func seeded(from config: NetworkConfig) -> NetworkSettingsForm {
    NetworkSettingsForm(
      ipOverride: config.source.localIP == .dbOverride ? (config.localIP ?? "") : "",
      portOverride: config.source.localPort == .dbOverride ? String(config.localPort) : "",
      enabled: config.enabled)
  }

  public enum ValidationResult: Equatable, Sendable {
    case valid(NetworkConfigPatch)
    case invalid(String)
  }

  /// Validate locally before spending a request. The server re-validates
  /// regardless; this exists so a typo produces an immediate message
  /// rather than a round-trip.
  public func validated() -> ValidationResult {
    let trimmedIP = ipOverride.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedPort = portOverride.trimmingCharacters(in: .whitespacesAndNewlines)

    let resolvedPort: Int?
    if trimmedPort.isEmpty {
      resolvedPort = nil
    } else if let parsed = Int(trimmedPort), (1...65535).contains(parsed) {
      resolvedPort = parsed
    } else {
      return .invalid("Port must be an integer between 1 and 65535.")
    }

    return .valid(
      NetworkConfigPatch(
        enabled: enabled,
        localIPOverride: trimmedIP.isEmpty ? nil : trimmedIP,
        localPortOverride: resolvedPort))
  }
}
