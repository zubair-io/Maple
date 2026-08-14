// NetworkConfig.swift — wire types for GET/PUT /api/network/config.
//
// The server resolves a LAN address for clients that can reach the box
// locally (src/api/src/routes/network.ts, network-config.repo.ts). A DB
// override wins over auto-detection; the `source` map reports which one
// produced each value, and the UI depends on that provenance — an
// auto-detected value must never be seeded into the override field.

import Foundation

/// Provenance of one resolved value. `local_ip` reports
/// `db_override | auto_detected | unavailable`; `local_port` reports
/// `db_override | default`. Unrecognised values decode to `.unknown` so a
/// newer server can't break the page.
public enum NetworkValueSource: String, Decodable, Sendable, Equatable {
  case dbOverride = "db_override"
  case autoDetected = "auto_detected"
  case unavailable
  case defaultValue = "default"
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = NetworkValueSource(rawValue: raw) ?? .unknown
  }
}

public struct NetworkConfigSource: Decodable, Sendable, Equatable {
  public let localIP: NetworkValueSource
  public let localPort: NetworkValueSource

  public init(localIP: NetworkValueSource, localPort: NetworkValueSource) {
    self.localIP = localIP
    self.localPort = localPort
  }

  enum CodingKeys: String, CodingKey {
    case localIP = "local_ip"
    case localPort = "local_port"
  }
}

public struct NetworkConfig: Decodable, Sendable, Equatable {
  public let enabled: Bool
  public let localIP: String?
  public let localPort: Int
  public let source: NetworkConfigSource

  public init(enabled: Bool, localIP: String?, localPort: Int, source: NetworkConfigSource) {
    self.enabled = enabled
    self.localIP = localIP
    self.localPort = localPort
    self.source = source
  }

  enum CodingKeys: String, CodingKey {
    case enabled
    case localIP = "local_ip"
    case localPort = "local_port"
    case source
  }
}

/// PUT body. Every field is sent on every save: a null clears the
/// corresponding override and falls back to auto-detection (IP) or the
/// server's listen port (port). Omitting a key would instead preserve the
/// stored override, which is not what the Save button means.
public struct NetworkConfigPatch: Encodable, Sendable, Equatable {
  public let enabled: Bool
  public let localIPOverride: String?
  public let localPortOverride: Int?

  public init(enabled: Bool, localIPOverride: String?, localPortOverride: Int?) {
    self.enabled = enabled
    self.localIPOverride = localIPOverride
    self.localPortOverride = localPortOverride
  }

  enum CodingKeys: String, CodingKey {
    case enabled
    case localIPOverride = "local_ip_override"
    case localPortOverride = "local_port_override"
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(enabled, forKey: .enabled)
    if let ip = localIPOverride {
      try c.encode(ip, forKey: .localIPOverride)
    } else {
      try c.encodeNil(forKey: .localIPOverride)
    }
    if let port = localPortOverride {
      try c.encode(port, forKey: .localPortOverride)
    } else {
      try c.encodeNil(forKey: .localPortOverride)
    }
  }
}
