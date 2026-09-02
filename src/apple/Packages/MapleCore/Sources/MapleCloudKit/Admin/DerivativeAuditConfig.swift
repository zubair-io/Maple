// DerivativeAuditConfig.swift — wire types for the derivative-audit
// maintenance panel (T5b, #2772).
//
// The derivative-audit worker re-arms a stage (thumb/preview/describe/
// cf-thumb-sync) when its derivative has drifted from the source of truth —
// most often after a file move. Mirrors
// DerivativeAuditSettingsComponent (src/web/.../workers/derivative-audit-settings.component.ts).

import Foundation

public struct DerivativeAuditConfig: Codable, Sendable, Equatable {
  public let enabled: Bool
  public let intervalMs: Int
  public let maxResetsPerPass: Int
  public let concurrency: Int
  public let deepR2Enabled: Bool
  public let updatedAt: Double?

  public init(
    enabled: Bool, intervalMs: Int, maxResetsPerPass: Int, concurrency: Int, deepR2Enabled: Bool,
    updatedAt: Double? = nil
  ) {
    self.enabled = enabled
    self.intervalMs = intervalMs
    self.maxResetsPerPass = maxResetsPerPass
    self.concurrency = concurrency
    self.deepR2Enabled = deepR2Enabled
    self.updatedAt = updatedAt
  }

  enum CodingKeys: String, CodingKey {
    case enabled
    case intervalMs = "interval_ms"
    case maxResetsPerPass = "max_resets_per_pass"
    case concurrency
    case deepR2Enabled = "deep_r2_enabled"
    case updatedAt = "updated_at"
  }
}

/// Last-pass summary. `byStage` keys are stage names (`thumb`, `preview`, …).
public struct DerivativeAuditSummary: Decodable, Sendable, Equatable {
  public let scanned: Int
  public let reArmed: Int
  public let byStage: [String: Int]
  public let skippedCooldown: Int
  public let errors: Int
  public let startedAt: String?
  public let finishedAt: String?
  public let running: Bool
}

public struct DerivativeAuditStatus: Decodable, Sendable, Equatable {
  public let config: DerivativeAuditConfig
  public let progress: DerivativeAuditSummary
}

/// PUT body — every field optional so a caller can patch just the toggle
/// (`enabled`) without re-sending the runtime knobs, matching the web
/// component's `toggleEnabled` vs. `save` split.
public struct DerivativeAuditConfigPatch: Encodable, Sendable, Equatable {
  public let enabled: Bool?
  public let intervalMs: Int?
  public let maxResetsPerPass: Int?
  public let concurrency: Int?
  public let deepR2Enabled: Bool?

  public init(
    enabled: Bool? = nil, intervalMs: Int? = nil, maxResetsPerPass: Int? = nil,
    concurrency: Int? = nil, deepR2Enabled: Bool? = nil
  ) {
    self.enabled = enabled
    self.intervalMs = intervalMs
    self.maxResetsPerPass = maxResetsPerPass
    self.concurrency = concurrency
    self.deepR2Enabled = deepR2Enabled
  }

  enum CodingKeys: String, CodingKey {
    case enabled
    case intervalMs = "interval_ms"
    case maxResetsPerPass = "max_resets_per_pass"
    case concurrency
    case deepR2Enabled = "deep_r2_enabled"
  }

  /// Omits every unset field rather than nulling it — the server's `t
  /// .Optional(t.Boolean())` etc. mean "omitted" leaves the DB value alone;
  /// there is no clear-to-default affordance on this document.
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(enabled, forKey: .enabled)
    try c.encodeIfPresent(intervalMs, forKey: .intervalMs)
    try c.encodeIfPresent(maxResetsPerPass, forKey: .maxResetsPerPass)
    try c.encodeIfPresent(concurrency, forKey: .concurrency)
    try c.encodeIfPresent(deepR2Enabled, forKey: .deepR2Enabled)
  }
}

/// `POST /api/derivative-audit/run` result.
public struct DerivativeAuditRunResult: Decodable, Sendable, Equatable {
  public let started: Bool
  public let reason: String?
}
