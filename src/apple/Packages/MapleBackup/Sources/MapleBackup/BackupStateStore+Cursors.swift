// Sources/MapleBackup/BackupStateStore+Cursors.swift
//
// Incremental-discovery cursors for PhotoKit backup: the serialized
// PHPersistentChangeToken, the settings fingerprint and finish time of the
// last completed full library scan, and the server `/backup/state` `since`
// cursor. A walk only takes the change-token shortcut while a recent full
// scan exists for the current settings; anything else is a full listing.

import Foundation
import GRDB

/// Persistent discovery cursors for a single device.
public struct BackupCursor: Sendable, Equatable {
  /// How long a completed full scan vouches for the change-token shortcut
  /// before a walk lists the whole library again.
  public static let fullScanInterval: TimeInterval = 7 * 24 * 60 * 60

  public let deviceId: String
  /// ISO-8601 `first_seen` cursor for `GET /api/libraries/:id/backup/state?since=...`.
  public let lastServerReconciledAt: String?
  /// Keyed-archiver `Data` of the PhotoKit change token taken when the last walk began.
  public let phChangeToken: Data?
  /// Fingerprint of the inclusion settings the last completed full scan used.
  public let settingsFingerprint: String?
  /// When that full scan finished; nil until one has.
  public let fullScanCompletedAt: Date?

  public init(
    deviceId: String,
    lastServerReconciledAt: String? = nil,
    phChangeToken: Data? = nil,
    settingsFingerprint: String? = nil,
    fullScanCompletedAt: Date? = nil
  ) {
    self.deviceId = deviceId
    self.lastServerReconciledAt = lastServerReconciledAt
    self.phChangeToken = phChangeToken
    self.settingsFingerprint = settingsFingerprint
    self.fullScanCompletedAt = fullScanCompletedAt
  }
}

/// How a walk finds the library's eligible assets.
public enum BackupDiscovery: Equatable, Sendable {
  /// Replay PhotoKit's persistent changes since this archived token.
  case changesSince(token: Data)
  /// List every eligible asset.
  case fullScan
}

extension BackupCursor {
  /// A walk replays changes only while a full scan finished for the current
  /// settings within `fullScanInterval`. A first run, an interrupted scan, a
  /// settings change, a retry of failures, the safety walk and a week without
  /// a full scan all list the whole library. So does a walk without an
  /// `hasEligibleBaseline`: a replay counts the library as the session last
  /// saw it, and the local rows alone cannot say which photos the listing
  /// leaves out (a setting, a hidden photo, limited access).
  public func discovery(
    settingsFingerprint fingerprint: String, retryFailed: Bool, forceFullScan: Bool,
    hasEligibleBaseline: Bool = true, now: Date = Date()
  ) -> BackupDiscovery {
    guard !retryFailed, !forceFullScan, hasEligibleBaseline, settingsFingerprint == fingerprint,
      let fullScanCompletedAt, now.timeIntervalSince(fullScanCompletedAt) < Self.fullScanInterval,
      let phChangeToken
    else { return .fullScan }
    return .changesSince(token: phChangeToken)
  }

  /// The server `since` cursor, or nil to fetch everything the server holds.
  /// A full scan reconciles against the full set, and so does any walk with an
  /// undelivered local edit: the edit re-send needs the server path of photos
  /// that may predate the cursor.
  public func serverSince(fullScan: Bool, hasUndeliveredEdits: Bool) -> String? {
    fullScan || hasUndeliveredEdits ? nil : lastServerReconciledAt
  }
}

extension BackupStateStore {

  static func createCursorsTable(in db: Database) throws {
    try db.create(table: "discovery_cursors", ifNotExists: true) { t in
      t.column("device_id", .text).primaryKey()
      t.column("last_server_reconciled_at", .text)
      t.column("ph_change_token", .blob)
      t.column("settings_fingerprint", .text)
      t.column("full_scan_completed_at", .double)
    }
  }

  public func cursor(deviceId: String) throws -> BackupCursor {
    try dbQueue.read { db in
      try Row.fetchOne(
        db,
        sql: "SELECT * FROM discovery_cursors WHERE device_id = ?",
        arguments: [deviceId]
      ).map { row in
        BackupCursor(
          deviceId: row["device_id"],
          lastServerReconciledAt: row["last_server_reconciled_at"],
          phChangeToken: row["ph_change_token"],
          settingsFingerprint: row["settings_fingerprint"],
          fullScanCompletedAt: (row["full_scan_completed_at"] as Double?).map(
            Date.init(timeIntervalSince1970:)))
      } ?? BackupCursor(deviceId: deviceId)
    }
  }

  /// Record a full library scan that listed and recorded every eligible asset.
  public func recordCompletedFullScan(
    deviceId: String, settingsFingerprint: String, phChangeToken: Data?, at date: Date = Date()
  ) throws {
    try dbQueue.write { db in
      try db.execute(
        sql: """
          INSERT INTO discovery_cursors
            (device_id, ph_change_token, settings_fingerprint, full_scan_completed_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(device_id) DO UPDATE SET
            ph_change_token = excluded.ph_change_token,
            settings_fingerprint = excluded.settings_fingerprint,
            full_scan_completed_at = excluded.full_scan_completed_at
          """,
        arguments: [deviceId, phChangeToken, settingsFingerprint, date.timeIntervalSince1970])
    }
  }

  public func updateServerReconciledAt(deviceId: String, since: String) throws {
    try dbQueue.write { db in
      try db.execute(
        sql: """
          INSERT INTO discovery_cursors (device_id, last_server_reconciled_at)
          VALUES (?, ?)
          ON CONFLICT(device_id) DO UPDATE SET
            last_server_reconciled_at = excluded.last_server_reconciled_at
          """,
        arguments: [deviceId, since])
    }
  }

  /// Records the token a walk began at. A token equal to the stored one is not
  /// written: a library change that leaves nothing to back up arrives often,
  /// and each write is a transaction. Returns whether it wrote.
  @discardableResult
  public func updatePhotoKitChangeToken(deviceId: String, token: Data?) throws -> Bool {
    guard try cursor(deviceId: deviceId).phChangeToken != token else { return false }
    try dbQueue.write { db in
      try db.execute(
        sql: """
          INSERT INTO discovery_cursors (device_id, ph_change_token)
          VALUES (?, ?)
          ON CONFLICT(device_id) DO UPDATE SET
            ph_change_token = excluded.ph_change_token
          """,
        arguments: [deviceId, token])
    }
    return true
  }
}
