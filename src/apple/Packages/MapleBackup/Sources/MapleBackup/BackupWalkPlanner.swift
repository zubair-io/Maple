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
  /// Rows to forget: photos that left Photos.
  public let forget: Set<String>
  /// Rows an excluded photo keeps for nothing: pending or failed, owing no
  /// companions. The store re-reads each before deleting it, since a worker
  /// may have delivered or begun to owe since the snapshot the plan reads.
  public let dropExcluded: Set<String>
  /// Pending rows of excluded photos that owe companions: kept, but not
  /// uploaded until the photo is listed again.
  public let suspend: Set<String>
  /// Photos that left Photos since the last walk this session, which the
  /// server is told about.
  public let deleted: Set<String>
  /// The eligible library: what the walk sees, so photos excluded by a
  /// setting stay out of the count.
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
  /// Suspended photos listed again, to queue where they left off.
  public let resume: [BackupTask]
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

  /// The rows a full scan under full access has no eligible photo for. Each is
  /// either gone from Photos or excluded by a setting; the walk asks PhotoKit
  /// which still exist. Empty for a replay and for a listing under limited
  /// access, which shows only part of the library.
  public static func unlisted(
    local: LocalTaskIndex, outcome: DiscoveryOutcome, fullLibraryAccess: Bool
  ) -> Set<String> {
    guard outcome.isFullScan, fullLibraryAccess else { return [] }
    return Set(local.stateByPhid.keys).subtracting(outcome.assets.map(\.phid))
  }

  /// A row is forgotten only for a photo PhotoKit no longer returns, so a
  /// photo a setting merely excludes keeps the record that its original is on
  /// the server, and the walk that includes it again does not upload it a
  /// second time. An excluded photo's row that records nothing delivered is
  /// dropped: a pending or failed row leaves the queue, as the setting asks.
  /// A row owing companions stays whatever its state, because its mark is the only
  /// record that the photo's Live Photo video or edited render never landed;
  /// one still pending is suspended so it cannot upload while excluded, and
  /// resumed when the photo is listed again.
  ///
  /// `previouslySeen` is the library as of the last walk this session, empty
  /// at launch; `stillInPhotoKit` the members of `unlisted` PhotoKit still
  /// has. A listing under limited (or since-revoked) access shows only part of
  /// the library, so it forgets only what this session saw and no longer
  /// does.
  ///
  /// Returns nil for a full listing with nothing in it while local rows exist
  /// and PhotoKit returns none of them either: PhotoKit may be unable to show
  /// a library that is there (an offline macOS library, a locked device), and
  /// forgetting every row on that evidence, or recording the scan complete,
  /// would lose the library's whole record. A listing emptied by the inclusion
  /// settings (a library of videos with videos off) is not that: PhotoKit
  /// still returns the excluded rows, so the walk reconciles them.
  public static func planLibrary(
    local: LocalTaskIndex, outcome: DiscoveryOutcome, previouslySeen: Set<String>,
    stillInPhotoKit: Set<String>, owingCompanions: Set<String>, fullLibraryAccess: Bool
  ) -> BackupLibraryPlan? {
    let listed = Set(outcome.assets.map(\.phid))
    let deleted: Set<String>
    let forget: Set<String>
    let dropExcluded: Set<String>
    let suspend: Set<String>
    if !outcome.isFullScan {
      deleted = outcome.deletedPhids
      forget = deleted
      dropExcluded = []
      suspend = []
    } else if listed.isEmpty && !local.stateByPhid.isEmpty && stillInPhotoKit.isEmpty {
      return nil
    } else if fullLibraryAccess {
      let notListed = unlisted(local: local, outcome: outcome, fullLibraryAccess: true)
      let gone = notListed.subtracting(stillInPhotoKit)
      let excluded = notListed.intersection(stillInPhotoKit)
      deleted = gone.intersection(previouslySeen)
      forget = gone
      dropExcluded = excluded.filter {
        !owingCompanions.contains($0) && local.stateByPhid[$0].map(deliveredNothing) == true
      }
      suspend = excluded.filter {
        owingCompanions.contains($0) && local.stateByPhid[$0] == .pending
      }
    } else {
      deleted = previouslySeen.subtracting(listed)
      forget = deleted
      dropExcluded = []
      suspend = []
    }
    let baseline = previouslySeen.isEmpty ? local.allPhids : previouslySeen
    let libraryPhotoIDs = outcome.isFullScan ? listed : baseline.subtracting(forget).union(listed)
    let discoveredPending = listed.filter {
      local.stateByPhid[$0] != .uploaded && local.stateByPhid[$0] != .skippedPolicy
    }
    return BackupLibraryPlan(
      forget: forget,
      dropExcluded: dropExcluded,
      suspend: suspend,
      deleted: deleted,
      libraryPhotoIDs: libraryPhotoIDs,
      pendingPhotoIDs: local.pendingPhids.intersection(libraryPhotoIDs).union(discoveredPending),
      backedUpPhotoIDs: local.backedUpPhids.intersection(libraryPhotoIDs))
  }

  private static func deliveredNothing(_ state: BackupState) -> Bool {
    switch state {
    case .uploaded, .uploading, .skippedPolicy: false
    case .observed, .pending, .failedRetry, .localEditPending: true
    }
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
      resume: outcome.assets
        .filter {
          local.stateByPhid[$0.phid] == .skippedPolicy && owingCompanions.contains($0.phid)
        }
        .map { task($0.phid, .pending) },
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
