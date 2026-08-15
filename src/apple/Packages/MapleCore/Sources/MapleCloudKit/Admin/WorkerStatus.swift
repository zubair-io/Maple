// WorkerStatus.swift — wire types for /api/workers/status and the
// `workers-status` WebSocket frame.
//
// Server shapes: `StageStatusRow` / `WorkersStatusPayload` in
// src/api/src/workers/routes-status.ts, and `WorkersStatusFrame` in
// workers/status-broadcast.ts.

import Foundation

/// A stage's run state.
///
/// The server's own union is `running | paused | stopped | error`, but the
/// web client also models `starting` and `restarting`, so both are accepted
/// here. Anything unrecognised decodes to `.unknown` rather than failing the
/// whole payload — one new state on the server must not blank the table.
public enum StageRunState: String, Decodable, Sendable, Equatable {
  case running
  case paused
  case stopped
  case error
  case starting
  case restarting
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = StageRunState(rawValue: raw) ?? .unknown
  }
}

public struct StageWorkerConfig: Decodable, Sendable, Equatable {
  public let concurrency: Int
  public let maxAttempts: Int
  public let paused: Bool

  public init(concurrency: Int, maxAttempts: Int, paused: Bool) {
    self.concurrency = concurrency
    self.maxAttempts = maxAttempts
    self.paused = paused
  }
}

public struct StageStatus: Decodable, Sendable, Equatable, Identifiable {
  public let name: String
  public let status: StageRunState
  public let inFlight: Int
  public let configured: Int
  public let pending: Int
  public let ready: Int
  public let blocked: Int
  public let dead: Int
  public let throughput: Double
  public let lastError: String?
  public let config: StageWorkerConfig?
  public let batchSize: Int

  public var id: String { name }

  public init(
    name: String, status: StageRunState, inFlight: Int, configured: Int, pending: Int,
    ready: Int, blocked: Int, dead: Int, throughput: Double, lastError: String?,
    config: StageWorkerConfig?, batchSize: Int
  ) {
    self.name = name
    self.status = status
    self.inFlight = inFlight
    self.configured = configured
    self.pending = pending
    self.ready = ready
    self.blocked = blocked
    self.dead = dead
    self.throughput = throughput
    self.lastError = lastError
    self.config = config
    self.batchSize = batchSize
  }
}

public struct WorkersStatusPayload: Decodable, Sendable, Equatable {
  public let stages: [StageStatus]
  /// Assets parked as unreadable, across all stages. Drives the Damaged
  /// chip. Absent from some payloads, so it defaults to zero.
  public let damaged: Int

  public init(stages: [StageStatus], damaged: Int = 0) {
    self.stages = stages
    self.damaged = damaged
  }

  enum CodingKeys: String, CodingKey {
    case stages
    case damaged
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    stages = try c.decode([StageStatus].self, forKey: .stages)
    damaged = try c.decodeIfPresent(Int.self, forKey: .damaged) ?? 0
  }
}

/// A `workers-status` push frame.
///
/// `counted` is the important field. False means the payload is a cheap
/// registry-only snapshot whose counts are zeroed and whose `config` is
/// null; applying one over real counts flashes "0 pending" across the table.
/// `WorkersFeed` is what enforces that.
public struct WorkersStatusFrame: Decodable, Sendable, Equatable {
  public let type: String
  public let status: WorkersStatusPayload
  public let counted: Bool
  public let ts: Double

  public init(type: String = "workers-status", status: WorkersStatusPayload, counted: Bool, ts: Double = 0) {
    self.type = type
    self.status = status
    self.counted = counted
    self.ts = ts
  }
}
