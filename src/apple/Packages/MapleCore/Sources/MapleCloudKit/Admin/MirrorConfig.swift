// MirrorConfig.swift — wire types for the per-library mirror/backup
// maintenance panel (T5b, #2772).
//
// A mirror is a second root every durable write/move under a library's
// primary root replicates to. Config is per-library
// (GET/PUT /api/folders/:id/mirror); reconcile status and the standing queue
// depth are server-wide (GET /api/mirror/status). Mirrors
// MirrorSettingsComponent (src/web/.../workers/mirror-settings.component.ts).

import Foundation

/// One configured mirror root. The UI shows one per library.
public struct MirrorLocation: Codable, Sendable, Equatable {
  public let path: String
  public let enabled: Bool

  public init(path: String, enabled: Bool) {
    self.path = path
    self.enabled = enabled
  }
}

/// One per-file error from a reconcile run.
public struct MirrorReconcileError: Decodable, Sendable, Equatable {
  public let path: String
  public let error: String
  public let at: String
}

/// Live two-stage progress of an operator "Reconcile now" run (scan → copy).
public struct MirrorReconcileProgress: Decodable, Sendable, Equatable {
  public enum Phase: String, Decodable, Sendable {
    case idle, scanning, copying
  }

  public struct ScanProgress: Decodable, Sendable, Equatable {
    public let scanned: Int
    public let toCopy: Int
    public let upToDate: Int
    public let errors: Int
  }

  public struct CopyProgress: Decodable, Sendable, Equatable {
    public let total: Int
    public let copied: Int
    public let remaining: Int
    public let errors: Int
  }

  public let phase: Phase
  public let scan: ScanProgress
  public let copy: CopyProgress
  public let currentPath: String?
  public let startedAt: String?
  public let finishedAt: String?
  public let errorLog: [MirrorReconcileError]
  public let copiedLog: [String]
}

/** Standing queue depth (pending waiting to copy / dead-lettered) plus live
 reconcile progress, for the Backup group on the Workers settings page. */
public struct MirrorQueueStatus: Decodable, Sendable, Equatable {
  public struct Queue: Decodable, Sendable, Equatable {
    public let pending: Int
    public let dead: Int
  }

  public let queue: Queue
  /// Absent on a server that has never run a reconcile.
  public let reconcile: MirrorReconcileProgress?
}

/// `POST /api/mirror/test` result.
public struct MirrorTestResult: Decodable, Sendable, Equatable {
  public let ok: Bool
  public let path: String?
  public let error: String?
}

/// `POST /api/mirror/reconcile` result.
public struct MirrorReconcileStartResult: Decodable, Sendable, Equatable {
  public let started: Bool
  public let phase: MirrorReconcileProgress.Phase
  public let reason: String?
}
