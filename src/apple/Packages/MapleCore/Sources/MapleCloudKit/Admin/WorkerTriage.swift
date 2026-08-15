// WorkerTriage.swift — wire types for the dead-job and damaged-asset
// lists (#2769).
//
// Server shapes are built inline in src/api/src/workers/routes-main.ts
// (`GET /:name/dead`, `GET /damaged`). Nearly every field is nullable
// there: a dead job may have no recorded error, and a damaged asset's tag
// may predate the fields that describe it. Modelling them as optional is
// accuracy, not defensiveness — the drawer's job is triage, and it has to
// render a half-known row rather than hide it.

import Foundation

/// One job a stage gave up on after exhausting `maxAttempts`.
public struct DeadJob: Decodable, Sendable, Equatable, Identifiable {
  public let id: String
  public let absPath: String?
  public let lastError: String?
  public let attempts: Int?
  public let processedAt: String?

  public init(
    id: String, absPath: String?, lastError: String?, attempts: Int?, processedAt: String?
  ) {
    self.id = id
    self.absPath = absPath
    self.lastError = lastError
    self.attempts = attempts
    self.processedAt = processedAt
  }

  enum CodingKeys: String, CodingKey {
    case id
    case absPath = "abs_path"
    case lastError = "last_error"
    case attempts
    case processedAt = "processed_at"
  }
}

/// An asset parked out of every stage because its bytes are unreadable.
public struct DamagedAsset: Decodable, Sendable, Equatable, Identifiable {
  public let id: String
  public let mapleID: String?
  public let absPath: String?
  /// The stage that tagged it — which is the one to look at first, not
  /// necessarily where the corruption came from.
  public let stage: String?
  public let reason: String?
  public let since: String?

  public init(
    id: String, mapleID: String?, absPath: String?, stage: String?, reason: String?, since: String?
  ) {
    self.id = id
    self.mapleID = mapleID
    self.absPath = absPath
    self.stage = stage
    self.reason = reason
    self.since = since
  }

  enum CodingKeys: String, CodingKey {
    case id
    case mapleID = "maple_id"
    case absPath = "abs_path"
    case stage
    case reason
    case since
  }
}

struct DeadJobsResponse: Decodable, Sendable {
  let items: [DeadJob]
}

struct DamagedAssetsResponse: Decodable, Sendable {
  let items: [DamagedAsset]
}

/// Result of a retry-dead or clear-damaged call.
///
/// The server reports how many documents it actually modified, which is
/// worth surfacing: "Retried 0" after clicking Retry means the rows were
/// already re-armed by something else, and is a different situation from
/// the call failing.
public struct TriageMutationResult: Sendable, Equatable {
  public let affected: Int

  public init(affected: Int) {
    self.affected = affected
  }
}

struct RetryDeadResponse: Decodable, Sendable {
  let reset: Int
}

struct ClearDamagedResponse: Decodable, Sendable {
  let cleared: Int
}
