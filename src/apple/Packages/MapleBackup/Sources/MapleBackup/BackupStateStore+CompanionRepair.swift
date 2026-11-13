// Sources/MapleBackup/BackupStateStore+CompanionRepair.swift
//
// Before #5777 a photo could be recorded as uploaded after its Live Photo
// video or edited render was dropped. A full scan compares the companions the
// server reports holding with the ones PhotoKit has, and re-queues each photo
// still missing one so the engine sends it again (#5778). A row is re-queued
// at most once per local store, so a companion that cannot land never turns
// into an upload loop.

import Foundation
import GRDB

/// The files a photo can carry beside its original on the server.
public struct BackupCompanions: OptionSet, Sendable, Hashable {
  public let rawValue: Int

  public init(rawValue: Int) {
    self.rawValue = rawValue
  }

  public static let liveVideo = BackupCompanions(rawValue: 1 << 0)
  public static let rendered = BackupCompanions(rawValue: 1 << 1)

  public init(liveVideo: Bool, rendered: Bool) {
    self = [liveVideo ? .liveVideo : [], rendered ? .rendered : []]
  }

  /// The companions a server's backup listing reports holding, or nil when it
  /// does not report them (a server that predates #5778).
  public init?(serverHasLiveVideo: Bool?, serverHasRendered: Bool?) {
    guard let serverHasLiveVideo, let serverHasRendered else { return nil }
    self.init(liveVideo: serverHasLiveVideo, rendered: serverHasRendered)
  }
}

public enum CompanionRepair {

  /// For each photo, the companions it has locally that the server reports
  /// lacking. A photo the server says nothing about (a server too old to
  /// report companions) is left out, as is the Live Photo video when Live
  /// Photos are excluded from backup.
  public static func lacking(
    local: [String: BackupCompanions],
    held: [String: BackupCompanions],
    includeLivePhotos: Bool
  ) -> [String: BackupCompanions] {
    let backedUp: BackupCompanions = includeLivePhotos ? [.liveVideo, .rendered] : [.rendered]
    return Dictionary(
      uniqueKeysWithValues: local.compactMap { phid, companions -> (String, BackupCompanions)? in
        guard let onServer = held[phid] else { return nil }
        let missing = companions.intersection(backedUp).subtracting(onServer)
        return missing.isEmpty ? nil : (phid, missing)
      })
  }

  /// Re-queues the uploaded photos still missing a companion the server
  /// lacks. `possible` is each library photo's companions as its subtype and
  /// edit state suggest; `onDevice` confirms them from the photo's resources,
  /// and is asked only about photos that are uploaded and not yet repaired.
  /// Returns the photos re-queued; throws when the store cannot save them.
  public static func requeueMissing(
    possible: [String: BackupCompanions],
    held: [String: BackupCompanions],
    includeLivePhotos: Bool,
    deviceId: String,
    capturedAt: [String: Date],
    state: BackupStateStore,
    queue: any BackupQueue,
    onDevice: @Sendable (Set<String>) async -> [String: BackupCompanions]
  ) async throws -> Set<String> {
    let suspects = lacking(local: possible, held: held, includeLivePhotos: includeLivePhotos)
    guard !suspects.isEmpty else { return [] }
    let candidates = try await state.companionRepairCandidates(
      deviceId: deviceId, among: Set(suspects.keys))
    guard !candidates.isEmpty else { return [] }
    let confirmed = await onDevice(candidates)
      .filter { candidates.contains($0.key) }
    let tasks = lacking(local: confirmed, held: held, includeLivePhotos: includeLivePhotos)
      .keys.sorted().map {
        BackupTask(
          id: BackupTaskID(deviceId: deviceId, phassetLocalId: $0),
          state: .pending, priority: .background, capturedAt: capturedAt[$0])
      }
    var requeued: Set<String> = []
    for offset in stride(from: 0, to: tasks.count, by: 256) {
      guard !Task.isCancelled else { break }
      let repaired = try await state.requeueForMissingCompanions(
        Array(tasks[offset..<min(offset + 256, tasks.count)]))
      requeued.formUnion(repaired.map(\.id.phassetLocalId))
      await queue.enqueue(repaired, priority: nil)
    }
    return requeued
  }
}

extension BackupStateStore {

  static func addCompanionRepairColumn(in db: Database, columns: [String]) throws {
    guard !columns.contains("companion_repair_queued") else { return }
    try db.execute(
      sql: "ALTER TABLE tasks ADD COLUMN companion_repair_queued INTEGER NOT NULL DEFAULT 0")
  }

  /// Of `phids`, the photos recorded as uploaded that a companion repair has
  /// not re-queued yet.
  public func companionRepairCandidates(
    deviceId: String, among phids: Set<String>
  ) throws -> Set<String> {
    guard !phids.isEmpty else { return [] }
    let unrepaired = try dbQueue.read { db in
      try String.fetchAll(
        db,
        sql: """
          SELECT phasset_local_id FROM tasks
           WHERE device_id = ? AND state = ? AND companion_repair_queued = 0
          """,
        arguments: [deviceId, BackupState.uploaded.rawValue])
    }
    return phids.intersection(unrepaired)
  }

  /// Re-queues uploaded photos the server holds without a companion, with a
  /// fresh retry budget. Each owes its companions, so a server-held original
  /// cannot settle it again, and is marked so no later scan re-queues it.
  /// Rows no longer uploaded, or repaired before, are left alone. Returns the
  /// tasks re-queued.
  public func requeueForMissingCompanions(_ tasks: [BackupTask]) throws -> [BackupTask] {
    try dbQueue.write { db in
      try tasks.filter { task in
        try db.execute(
          sql: """
            UPDATE tasks
               SET state = ?, retry_count = 0, last_error = NULL, priority = ?,
                   enqueued_at = ?, captured_at = COALESCE(?, captured_at),
                   companions_owed = 1, companion_repair_queued = 1
             WHERE device_id = ? AND phasset_local_id = ? AND state = ?
               AND companion_repair_queued = 0
            """,
          arguments: [
            BackupState.pending.rawValue, task.priority.rawValue,
            task.enqueuedAt.timeIntervalSince1970, task.capturedAt?.timeIntervalSince1970,
            task.id.deviceId, task.id.phassetLocalId, BackupState.uploaded.rawValue,
          ])
        return db.changesCount > 0
      }
    }
  }
}
