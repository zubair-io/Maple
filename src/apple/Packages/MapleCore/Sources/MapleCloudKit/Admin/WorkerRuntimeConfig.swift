// WorkerRuntimeConfig.swift — wire types for the per-stage runtime knobs
// and the three stage-specific one-offs (#2770).
//
// Routes in src/api/src/workers/routes-main.ts.

import Foundation

/// Body for `PATCH /api/workers/:name/config`.
///
/// Only the three live knobs exist as fields. `pollIntervalMs` and
/// `batchSize` were retired as knobs in #674 — poll cadence is a global
/// constant and batch size is derived as 5×concurrency — and the route
/// **400s** if either key appears in the payload rather than ignoring it.
/// Modelling the body as a fixed struct rather than a dictionary makes
/// sending one a compile-time impossibility instead of a runtime failure.
public struct StageRuntimePatch: Encodable, Sendable, Equatable {
  public let concurrency: Int?
  public let maxAttempts: Int?
  public let paused: Bool?

  public init(concurrency: Int? = nil, maxAttempts: Int? = nil, paused: Bool? = nil) {
    self.concurrency = concurrency
    self.maxAttempts = maxAttempts
    self.paused = paused
  }

  /// Omits absent fields — this is a patch, and a null would be a value.
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(concurrency, forKey: .concurrency)
    try c.encodeIfPresent(maxAttempts, forKey: .maxAttempts)
    try c.encodeIfPresent(paused, forKey: .paused)
  }

  enum CodingKeys: String, CodingKey {
    case concurrency
    case maxAttempts
    case paused
  }
}

public struct StageRuntimeResponse: Decodable, Sendable, Equatable {
  public let ok: Bool
  /// Null when the stage has no persisted config document yet.
  public let config: StageWorkerConfig?

  public init(ok: Bool, config: StageWorkerConfig?) {
    self.ok = ok
    self.config = config
  }
}

// MARK: - Missing-reaper prune window

public struct PruneWindow: Decodable, Sendable, Equatable {
  public let hours: Int

  public init(hours: Int) { self.hours = hours }
}

// MARK: - Preview decode pool

/// `GET /api/workers/performance`.
///
/// `ffiWorkers` sizes the RAW decode pool. `source` says whether the value
/// came from the database, an environment variable, or the built-in
/// default — worth showing, because an env-var value cannot be changed from
/// this screen and silently ignoring a save would be confusing.
public struct WorkerPerformance: Decodable, Sendable, Equatable {
  public let ffiWorkers: Int
  public let source: String
  public let min: Int
  public let max: Int
  public let pool: Pool?

  public struct Pool: Decodable, Sendable, Equatable {
    public let target: Int
    public let spawned: Int
    public let busy: Int
    public let queued: Int

    public init(target: Int, spawned: Int, busy: Int, queued: Int) {
      self.target = target
      self.spawned = spawned
      self.busy = busy
      self.queued = queued
    }
  }

  public init(ffiWorkers: Int, source: String, min: Int, max: Int, pool: Pool?) {
    self.ffiWorkers = ffiWorkers
    self.source = source
    self.min = min
    self.max = max
    self.pool = pool
  }

  enum CodingKeys: String, CodingKey {
    case ffiWorkers = "ffi_workers"
    case source
    case min
    case max
    case pool
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    ffiWorkers = try c.decode(Int.self, forKey: .ffiWorkers)
    source = try c.decodeIfPresent(String.self, forKey: .source) ?? "default"
    // The bounds are advertised by the server; fall back to the documented
    // clamp rather than inventing a wider range if they're ever absent.
    min = try c.decodeIfPresent(Int.self, forKey: .min) ?? 1
    max = try c.decodeIfPresent(Int.self, forKey: .max) ?? 16
    pool = try c.decodeIfPresent(Pool.self, forKey: .pool)
  }
}

// MARK: - Migrations

public struct MigrationInfo: Decodable, Sendable, Equatable, Identifiable {
  public let id: String
  public let title: String
  public let description: String?
  public let enabled: Bool
  public let status: String
  public let processed: Int
  public let errors: Int
  public let remaining: Int
  public let lastError: String?

  public init(
    id: String, title: String, description: String?, enabled: Bool, status: String,
    processed: Int, errors: Int, remaining: Int, lastError: String?
  ) {
    self.id = id
    self.title = title
    self.description = description
    self.enabled = enabled
    self.status = status
    self.processed = processed
    self.errors = errors
    self.remaining = remaining
    self.lastError = lastError
  }

  enum CodingKeys: String, CodingKey {
    case id, title, description, enabled, status, processed, errors, remaining
    case lastError = "last_error"
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? id
    description = try c.decodeIfPresent(String.self, forKey: .description)
    enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
    status = try c.decodeIfPresent(String.self, forKey: .status) ?? "idle"
    processed = try c.decodeIfPresent(Int.self, forKey: .processed) ?? 0
    errors = try c.decodeIfPresent(Int.self, forKey: .errors) ?? 0
    remaining = try c.decodeIfPresent(Int.self, forKey: .remaining) ?? 0
    lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
  }
}

struct MigrationsResponse: Decodable, Sendable {
  let migrations: [MigrationInfo]
}

/// Body for `PATCH /api/workers/migration/migrations/:id` — either flips
/// the enable flag or resets progress, never both.
public enum MigrationCommand: Encodable, Sendable, Equatable {
  case setEnabled(Bool)
  case reset

  enum CodingKeys: String, CodingKey {
    case enabled
    case reset
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .setEnabled(let on): try c.encode(on, forKey: .enabled)
    case .reset: try c.encode(true, forKey: .reset)
    }
  }
}
