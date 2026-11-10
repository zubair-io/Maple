// Sources/MapleBackup/BackupWalkPlanner.swift
//
// What a PhotoKit library walk decides, apart from the PhotoKit, network and
// SQLite work that carries the decisions out: which local rows to forget,
// which photos the server already holds, which failed ones to retry and which
// to enqueue. Pure functions over a snapshot of the local rows, so the order
// the app applies them in is exercised by `swift test` against a real store.
//
// A walk plans in two steps because the server check sits between them: the
// library plan needs only the listing and the local rows, and the status
// panel shows it while the server answers; the reconcile plan then needs the
// server's holdings too.

import Foundation

/// An eligible photo a walk found, with what its subtype and edit state say
/// it may carry beside the original; the companion repair confirms these
/// against the photo's resources.
public struct DiscoveredAsset: Sendable, Equatable {
  public let phid: String
  public let capturedAt: Date?
  public let possibleCompanions: BackupCompanions

  public init(phid: String, capturedAt: Date?, possibleCompanions: BackupCompanions) {
    self.phid = phid
    self.capturedAt = capturedAt
    self.possibleCompanions = possibleCompanions
  }
}

/// Every eligible asset after a full scan, or only those PhotoKit reports
/// inserted since the saved token, with the ones it reports deleted.
public struct DiscoveryOutcome: Sendable {
  public let assets: [DiscoveredAsset]
  public let deletedPhids: Set<String>
  public let newToken: Data?
  public let isFullScan: Bool

  public init(
    assets: [DiscoveredAsset], deletedPhids: Set<String>, newToken: Data?, isFullScan: Bool
  ) {
    self.assets = assets
    self.deletedPhids = deletedPhids
    self.newToken = newToken
    self.isFullScan = isFullScan
  }
}

/// One device's local rows, indexed for a walk.
public struct LocalTaskIndex: Sendable {
  public let stateByPhid: [String: BackupState]
  /// Every photo with a row that is not `.skippedPolicy`.
  public let allPhids: Set<String>
  public let backedUpPhids: Set<String>
  public let pendingPhids: Set<String>
  public let nullDatePendingPhids: Set<String>

  public init(tasks: [BackupTask], deviceId: String) {
    let own = tasks.filter { $0.id.deviceId == deviceId }
    let tracked = own.filter { $0.state != .skippedPolicy }
    stateByPhid = Dictionary(
      own.map { ($0.id.phassetLocalId, $0.state) }, uniquingKeysWith: { _, latest in latest })
    allPhids = Set(tracked.map(\.id.phassetLocalId))
    backedUpPhids = Set(tracked.filter { $0.state == .uploaded }.map(\.id.phassetLocalId))
    pendingPhids = Set(tracked.filter { $0.state != .uploaded }.map(\.id.phassetLocalId))
    nullDatePendingPhids = Set(
      own.filter { $0.state == .pending && $0.capturedAt == nil }.map(\.id.phassetLocalId))
  }
}

/// Which photos are in the library after this walk, and which rows to forget.
public struct BackupLibraryPlan: Sendable {
  /// Rows for photos that left the library.
  public let forget: Set<String>
  public let libraryPhotoIDs: Set<String>
  public let pendingPhotoIDs: Set<String>
  /// Photos the local rows alone record as uploaded.
  public let backedUpPhotoIDs: Set<String>
}

/// What the walk writes once the server has said what it holds.
public struct BackupReconcilePlan: Sendable {
  /// Server-held photos to record as uploaded.
  public let settle: [BackupTask]
  /// Failed photos to re-queue with a fresh retry budget.
  public let retry: [BackupTask]
  /// Photos neither the local rows nor the server have.
  public let enqueue: [BackupTask]
  /// Capture dates for pending rows stored without one.
  public let datesToBackfill: [String: Date]
  /// Library photos backed up, by the local rows or the server.
  public let backedUpPhotoIDs: Set<String>
  /// Photos the server holds whole: its holding settles them.
  public let serverBackedUpPhotoIDs: Set<String>
}

public enum BackupWalkPlanner {

  /// `deletedPhids` are the photos known to have left Photos: PhotoKit's own
  /// report on a replay, the diff against the last walk on a full scan. A full
  /// listing under full access forgets every row it lacks; a listing under
  /// limited (or since-revoked) access shows only part of the library, so it
  /// forgets only what it saw deleted.
  public static func planLibrary(
    local: LocalTaskIndex, outcome: DiscoveryOutcome, deletedPhids: Set<String>,
    fullLibraryAccess: Bool
  ) -> BackupLibraryPlan {
    let listed = Set(outcome.assets.map(\.phid))
    let listedWholeLibrary = outcome.isFullScan && fullLibraryAccess
    let forget =
      listedWholeLibrary ? Set(local.stateByPhid.keys).subtracting(listed) : deletedPhids
    let libraryPhotoIDs =
      outcome.isFullScan ? listed : local.allPhids.subtracting(forget).union(listed)
    let discoveredPending = listed.filter {
      local.stateByPhid[$0] != .uploaded && local.stateByPhid[$0] != .skippedPolicy
    }
    return BackupLibraryPlan(
      forget: forget,
      libraryPhotoIDs: libraryPhotoIDs,
      pendingPhotoIDs: local.pendingPhids.subtracting(forget).union(discoveredPending),
      backedUpPhotoIDs: local.backedUpPhids.intersection(libraryPhotoIDs))
  }

  /// `owingCompanions` are the photos whose Live Photo video or edited render
  /// is still undelivered: the server holding the original never settles them.
  public static func planReconcile(
    local: LocalTaskIndex, library: BackupLibraryPlan, outcome: DiscoveryOutcome,
    deviceId: String, serverKnownPhids: Set<String>, owingCompanions: Set<String>,
    retryFailed: Bool
  ) -> BackupReconcilePlan {
    let serverBackedUp = serverKnownPhids.subtracting(owingCompanions)
    let capturedAtByPhid = Dictionary(
      outcome.assets.compactMap { asset in asset.capturedAt.map { (asset.phid, $0) } },
      uniquingKeysWith: { first, _ in first })
    func task(_ phid: String, _ state: BackupState) -> BackupTask {
      BackupTask(
        id: BackupTaskID(deviceId: deviceId, phassetLocalId: phid),
        state: state, priority: .background, capturedAt: capturedAtByPhid[phid])
    }
    return BackupReconcilePlan(
      settle: serverKnownPhids.intersection(library.libraryPhotoIDs)
        .filter { local.stateByPhid[$0] != .uploaded }
        .sorted().map { task($0, .uploaded) },
      retry: retryFailed
        ? outcome.assets.filter { local.stateByPhid[$0.phid] == .failedRetry }
          .map { task($0.phid, .pending) }
        : [],
      enqueue: outcome.assets
        .filter { !serverKnownPhids.contains($0.phid) && local.stateByPhid[$0.phid] == nil }
        .map { task($0.phid, .pending) },
      datesToBackfill: capturedAtByPhid.filter {
        local.nullDatePendingPhids.contains($0.key) && !serverKnownPhids.contains($0.key)
      },
      backedUpPhotoIDs: local.backedUpPhids.union(serverBackedUp)
        .intersection(library.libraryPhotoIDs),
      serverBackedUpPhotoIDs: serverBackedUp)
  }
}
