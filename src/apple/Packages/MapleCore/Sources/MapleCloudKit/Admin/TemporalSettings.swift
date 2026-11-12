// TemporalSettings.swift — wire types for GET/PUT /api/workers/temporal
// (#5826): where the server finds its Temporal job server, and what the
// worker tier last saw there.
//
// Server shape: `TemporalStatus` in src/api/src/temporal/temporal-config.ts.

import Foundation

/// `unknown` means the worker tier has not reported on the currently saved
/// target yet — right after a save, or while the worker tier is down.
public enum TemporalConnectionState: String, Decodable, Sendable, Equatable {
  case connected
  case unreachable
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = TemporalConnectionState(rawValue: raw) ?? .unknown
  }
}

public struct TemporalConnection: Decodable, Sendable, Equatable {
  public let state: TemporalConnectionState
  public let error: String?
  public let checkedAt: Date?

  public init(state: TemporalConnectionState, error: String? = nil, checkedAt: Date? = nil) {
    self.state = state
    self.error = error
    self.checkedAt = checkedAt
  }

  enum CodingKeys: String, CodingKey {
    case state
    case error
    case checkedAt
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let checkedAtMs = try c.decodeIfPresent(Double.self, forKey: .checkedAt)
    self.init(
      state: try c.decode(TemporalConnectionState.self, forKey: .state),
      error: try c.decodeIfPresent(String.self, forKey: .error),
      checkedAt: checkedAtMs.map { Date(timeIntervalSince1970: $0 / 1000) })
  }

  public var label: String {
    switch state {
    case .connected: return "Connected"
    case .unreachable: return "Unreachable"
    case .unknown: return "Connecting"
    }
  }

  public var detail: String? {
    switch state {
    case .connected:
      return checkedAt.map {
        "Last checked \($0.formatted(date: .omitted, time: .standard))"
      }
    case .unreachable:
      return error ?? "Maple could not reach this Temporal server."
    case .unknown:
      return "Waiting for the worker to report on this address."
    }
  }
}

public struct TemporalSettings: Decodable, Sendable, Equatable {
  public let address: String
  public let namespace: String
  public let connection: TemporalConnection

  public init(address: String, namespace: String, connection: TemporalConnection) {
    self.address = address
    self.namespace = namespace
    self.connection = connection
  }

  /// The worker tier reports within about ten seconds of a save, so an
  /// unreported target is re-read quickly and a settled one slowly.
  public var nextPollDelay: Duration {
    connection.state == .unknown ? .seconds(2) : .seconds(10)
  }
}

/// PUT body. Nil when either field is blank after trimming — the server
/// rejects that too, so there is nothing worth sending.
public struct TemporalTarget: Encodable, Sendable, Equatable {
  public let address: String
  public let namespace: String

  public init?(address: String, namespace: String) {
    let trimmedAddress = address.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedNamespace = namespace.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedAddress.isEmpty, !trimmedNamespace.isEmpty else { return nil }
    self.address = trimmedAddress
    self.namespace = trimmedNamespace
  }
}
