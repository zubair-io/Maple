// Tests/MapleBackupTests/BackupWalkPlannerTests.swift
// What a library walk forgets, settles, retries and enqueues, planned from the
// rows a real SQLite store holds and carried out with the store calls the app's
// walk makes, in its order.
import Foundation
import XCTest

@testable import MapleBackup

final class BackupWalkPlannerTests: XCTestCase {

  private let device = "d"

  private func id(_ phid: String) -> BackupTaskID {
    BackupTaskID(deviceId: device, phassetLocalId: phid)
  }

  private func freshStore() throws -> BackupStateStore {
    try BackupStateStore(
      databaseURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("backup-planner-\(UUID().uuidString).sqlite"))
  }

  private func row(_ phid: String, _ state: BackupState, retryCount: Int = 0) -> BackupTask {
    BackupTask(id: id(phid), state: state, priority: .background, retryCount: retryCount)
  }

  private func asset(_ phid: String, capturedAt: Date? = nil) -> DiscoveredAsset {
    DiscoveredAsset(phid: phid, capturedAt: capturedAt, possibleCompanions: [])
  }

  private func state(_ store: BackupStateStore, _ phid: String) async throws -> BackupState? {
    try await store.find(id(phid))?.state
  }

  /// One walk the way the app runs it: plan the library, forget, plan against
  /// the server's holdings, then settle, retry and enqueue. `previouslySeen`
  /// is the library as of the last walk this session; `inPhotoKit` the photos
  /// PhotoKit still has, of which the walk asks about the unlisted ones.
  @discardableResult
  private func walk(
    _ store: BackupStateStore, listing: [DiscoveredAsset], isFullScan: Bool = true,
    deletedPhids: Set<String> = [], previouslySeen: Set<String> = [],
    inPhotoKit: Set<String> = [], fullLibraryAccess: Bool = true,
    serverKnown: Set<String> = [], retryFailed: Bool = false
  ) async throws -> (library: BackupLibraryPlan, reconcile: BackupReconcilePlan) {
    let outcome = DiscoveryOutcome(
      assets: listing, deletedPhids: deletedPhids, newToken: nil, isFullScan: isFullScan)
    let local = LocalTaskIndex(tasks: try await store.allTasks(), deviceId: device)
    let owing = try await store.phidsOwingCompanions(deviceId: device)
    let unlisted = BackupWalkPlanner.unlisted(
      local: local, outcome: outcome, fullLibraryAccess: fullLibraryAccess)
    let planned = BackupWalkPlanner.planLibrary(
      local: local, outcome: outcome, previouslySeen: previouslySeen,
      stillInPhotoKit: inPhotoKit.intersection(unlisted), owingCompanions: owing,
      fullLibraryAccess: fullLibraryAccess)
    let library = try XCTUnwrap(planned)
    _ = try await store.removeDeleted(library.forget.map(id))
    _ = try await store.removeExcluded(library.dropExcluded.map(id))
    _ = try await store.suspendExcluded(library.suspend.map(id))
    let reconcile = BackupWalkPlanner.planReconcile(
      local: local, library: library, outcome: outcome, deviceId: device,
      serverKnownPhids: serverKnown, owingCompanions: owing, retryFailed: retryFailed)
    _ = try await store.markServerHeld(reconcile.settle)
    _ = try await store.requeueFailed(reconcile.retry)
    _ = try await store.resumeExcluded(reconcile.resume)
    try await store.upsert(reconcile.enqueue)
    return (library, reconcile)
  }

  func testIndexCoversOnlyThisDevicesTrackedRows() {
    let other = BackupTask(
      id: BackupTaskID(deviceId: "other", phassetLocalId: "O"), state: .uploaded,
      priority: .background)
    let index = LocalTaskIndex(
      tasks: [
        row("up", .uploaded), row("pend", .pending), row("fail", .failedRetry),
        row("skip", .skippedPolicy),
        BackupTask(
          id: id("undated"), state: .pending, priority: .background, capturedAt: nil),
        BackupTask(
          id: id("dated"), state: .pending, priority: .background,
          capturedAt: Date(timeIntervalSince1970: 1)),
        other,
      ], deviceId: device)

    XCTAssertEqual(index.stateByPhid["skip"], .skippedPolicy)
    XCTAssertNil(index.stateByPhid["O"])
    XCTAssertEqual(index.allPhids, ["up", "pend", "fail", "undated", "dated"])
    XCTAssertEqual(index.backedUpPhids, ["up"])
    XCTAssertEqual(index.pendingPhids, ["pend", "fail", "undated", "dated"])
    XCTAssertEqual(index.nullDatePendingPhids, ["pend", "undated"])
  }

  func testFullScanForgetsRowsTheListingLacksAndCancelsOnlyPendingOnes() async throws {
    let store = try freshStore()
    try await store.upsert([
      row("keep", .uploaded), row("gone", .uploaded), row("queued", .pending),
    ])

    let plan = try await walk(store, listing: [asset("keep")]).library

    XCTAssertEqual(plan.forget, ["gone", "queued"])
    XCTAssertEqual(plan.dropExcluded, [])
    XCTAssertEqual(plan.libraryPhotoIDs, ["keep"])
    XCTAssertEqual(plan.backedUpPhotoIDs, ["keep"])
    XCTAssertEqual(plan.pendingPhotoIDs, [])
    let gone = try await state(store, "gone")
    XCTAssertNil(gone)
    let kept = try await state(store, "keep")
    XCTAssertEqual(kept, .uploaded)
  }

  func testLimitedAccessListingForgetsOnlyWhatTheSessionSawAndNoLongerSees() async throws {
    let store = try freshStore()
    try await store.upsert([row("hidden", .uploaded), row("deselected", .uploaded)])

    let plan = try await walk(
      store, listing: [asset("visible")], previouslySeen: ["deselected"],
      inPhotoKit: ["hidden"], fullLibraryAccess: false
    ).library

    XCTAssertEqual(plan.forget, ["deselected"])
    XCTAssertEqual(plan.deleted, ["deselected"])
    let hidden = try await state(store, "hidden")
    XCTAssertEqual(hidden, .uploaded, "a partial listing says nothing about photos it omits")
    XCTAssertEqual(plan.libraryPhotoIDs, ["visible"])
  }

  func testReplayFoldsInsertionsAndDeletionsIntoTheLocalLibrary() async throws {
    let store = try freshStore()
    try await store.upsert([
      row("old", .uploaded), row("deleted", .uploaded), row("busy", .pending),
    ])

    let plan = try await walk(
      store, listing: [asset("new")], isFullScan: false, deletedPhids: ["deleted"]
    ).library

    XCTAssertEqual(plan.forget, ["deleted"])
    XCTAssertEqual(plan.libraryPhotoIDs, ["old", "busy", "new"])
    XCTAssertEqual(plan.backedUpPhotoIDs, ["old"])
    XCTAssertEqual(plan.pendingPhotoIDs, ["busy", "new"])
  }

  func testToggleOffThenOnWithAFailingServerCheckDoesNotRequeueUploadedPhotos() async throws {
    let store = try freshStore()
    try await walk(
      store, listing: [asset("photo"), asset("video")], serverKnown: ["photo", "video"])

    let off = try await walk(
      store, listing: [asset("photo")], previouslySeen: ["photo", "video"],
      inPhotoKit: ["video"], serverKnown: ["photo"])
    XCTAssertEqual(off.library.forget, [], "an excluded photo still exists in Photos")
    XCTAssertEqual(off.library.deleted, [])
    XCTAssertEqual(off.library.libraryPhotoIDs, ["photo"], "an excluded photo is not counted")
    let excluded = try await state(store, "video")
    XCTAssertEqual(excluded, .uploaded)

    let on = try await walk(
      store, listing: [asset("photo"), asset("video")], previouslySeen: ["photo"],
      serverKnown: [])
    XCTAssertEqual(on.reconcile.enqueue, [], "/backup/state failed: the local record must hold")
    let included = try await state(store, "video")
    XCTAssertEqual(included, .uploaded)
  }

  func testExcludedPhotoKeepsItsRowOnlyWhenItRecordsADeliveryOrOwesCompanions() async throws {
    let store = try freshStore()
    try await store.upsert([
      row("uploaded", .uploaded), row("owing", .failedRetry),
      row("retrying", .pending, retryCount: 2),
      row("queued", .pending), row("failed", .failedRetry),
    ])
    try await store.markCompanionsOwed(id("owing"))
    try await store.markCompanionsOwed(id("retrying"))
    let everyone: Set = ["uploaded", "owing", "retrying", "queued", "failed"]

    let plan = try await walk(
      store, listing: [asset("other")], previouslySeen: everyone.union(["other"]),
      inPhotoKit: everyone
    ).library

    XCTAssertEqual(plan.forget, [])
    XCTAssertEqual(plan.dropExcluded, ["queued", "failed"])
    XCTAssertEqual(plan.deleted, [])
    XCTAssertEqual(plan.libraryPhotoIDs, ["other"])
    XCTAssertEqual(plan.pendingPhotoIDs, ["other"])
    for kept in ["uploaded", "owing", "retrying"] {
      let row = try await store.find(id(kept))
      XCTAssertNotNil(row, "\(kept) must survive")
    }
    let owing = try await store.phidsOwingCompanions(deviceId: device)
    XCTAssertEqual(owing, ["owing", "retrying"])
  }

  func testAnOwingRowSurvivesTheWalkThatIncludesItAgainAndIsNotSettledByTheServer() async throws {
    let store = try freshStore()
    try await store.upsert([row("video", .failedRetry)])
    try await store.markCompanionsOwed(id("video"))
    try await walk(
      store, listing: [asset("photo")], previouslySeen: ["photo", "video"], inPhotoKit: ["video"])

    let back = try await walk(
      store, listing: [asset("photo"), asset("video")], previouslySeen: ["photo"],
      serverKnown: ["video"])

    XCTAssertEqual(back.reconcile.backedUpPhotoIDs, [])
    XCTAssertEqual(back.reconcile.enqueue, [])
    let video = try await state(store, "video")
    XCTAssertEqual(video, .failedRetry, "the server holding the original does not settle it")
  }

  func testRowsPhotoKitNoLongerReturnsAreForgottenAndTheSessionsDeletionsReported() async throws {
    let store = try freshStore()
    try await store.upsert([
      row("keep", .uploaded), row("deleted", .uploaded), row("olderDeletion", .uploaded),
      row("owing", .failedRetry),
    ])
    try await store.markCompanionsOwed(id("owing"))

    let plan = try await walk(
      store, listing: [asset("keep")], previouslySeen: ["keep", "deleted", "owing"]
    ).library

    XCTAssertEqual(plan.forget, ["deleted", "olderDeletion", "owing"])
    XCTAssertEqual(
      plan.deleted, ["deleted", "owing"], "only this session's deletions are reported")
    let gone = try await state(store, "owing")
    XCTAssertNil(gone, "a photo deleted from Photos can never deliver its companions")
  }

  func testAnExcludedRowDeliveredSinceThePlansSnapshotIsKeptNotDeleted() async throws {
    let store = try freshStore()
    try await store.upsert([row("raced", .pending, retryCount: 1), row("idle", .pending)])
    let local = LocalTaskIndex(tasks: try await store.allTasks(), deviceId: device)
    let outcome = DiscoveryOutcome(
      assets: [asset("other")], deletedPhids: [], newToken: nil, isFullScan: true)
    let library = try XCTUnwrap(
      BackupWalkPlanner.planLibrary(
        local: local, outcome: outcome, previouslySeen: ["other", "raced", "idle"],
        stillInPhotoKit: ["raced", "idle"], owingCompanions: [], fullLibraryAccess: true))
    XCTAssertEqual(library.dropExcluded, ["raced", "idle"])

    try await store.transition(id("raced"), to: .uploaded)
    let cancelled = try await store.removeExcluded(library.dropExcluded.sorted().map(id))

    XCTAssertEqual(cancelled, [id("idle")])
    let raced = try await state(store, "raced")
    XCTAssertEqual(raced, .uploaded, "a delivery the snapshot predates must not be deleted")
    let idle = try await state(store, "idle")
    XCTAssertNil(idle)
  }

  func testAnExcludedRowThatStartedOwingCompanionsSinceThePlansSnapshotIsKept() async throws {
    let store = try freshStore()
    try await store.upsert([
      row("failed", .failedRetry), row("retry", .pending, retryCount: 2),
      row("claimed", .uploading),
    ])
    try await store.markCompanionsOwed(id("failed"))
    try await store.markCompanionsOwed(id("retry"))

    let cancelled = try await store.removeExcluded(
      ["failed", "retry", "claimed", "unknown"].map(id))

    XCTAssertEqual(cancelled, [id("retry")], "the parked retry leaves the queue")
    let failed = try await state(store, "failed")
    XCTAssertEqual(failed, .failedRetry, "its mark is the only record the companions never landed")
    let retry = try await store.find(id("retry"))
    XCTAssertEqual(
      retry?.state, .skippedPolicy, "parked, as the walk parks an owing excluded retry")
    XCTAssertEqual(retry?.retryCount, 2)
    let claimed = try await state(store, "claimed")
    XCTAssertEqual(claimed, .uploading)
    let owing = try await store.phidsOwingCompanions(deviceId: device)
    XCTAssertEqual(owing, ["failed", "retry"])
  }

  func testReturningToPendingLeavesRowsAWalkSettledOrParked() async throws {
    let store = try freshStore()
    try await store.upsert([
      row("queued", .pending, retryCount: 1), row("settled", .uploaded),
      row("parked", .skippedPolicy),
    ])

    let queued = try await store.returnToPending(id("queued"))
    let settled = try await store.returnToPending(id("settled"))
    let parked = try await store.returnToPending(id("parked"))
    let unknown = try await store.returnToPending(id("unknown"))

    XCTAssertTrue(queued)
    XCTAssertFalse(settled)
    XCTAssertFalse(parked)
    XCTAssertFalse(unknown)
    let settledState = try await state(store, "settled")
    XCTAssertEqual(settledState, .uploaded)
    let parkedState = try await state(store, "parked")
    XCTAssertEqual(parkedState, .skippedPolicy)
  }

  func testAnEmptyListingWithLocalRowsForgetsAndRecordsNothing() async throws {
    let store = try freshStore()
    try await store.upsert([row("a", .uploaded), row("b", .pending)])
    let local = LocalTaskIndex(tasks: try await store.allTasks(), deviceId: device)
    let outcome = DiscoveryOutcome(assets: [], deletedPhids: [], newToken: nil, isFullScan: true)

    let plan = BackupWalkPlanner.planLibrary(
      local: local, outcome: outcome, previouslySeen: ["a", "b"], stillInPhotoKit: [],
      owingCompanions: [], fullLibraryAccess: true)

    XCTAssertNil(plan, "no plan means no forgetting and no completed-scan stamp")
    let kept = try await store.allTasks()
    XCTAssertEqual(kept.count, 2)
  }

  func testAListingEmptiedBySettingsStillDropsTheExcludedPhotosUndeliveredWork() async throws {
    let store = try freshStore()
    try await store.upsert([row("sent", .uploaded), row("queued", .pending)])

    let plan = try await walk(store, listing: [], inPhotoKit: ["sent", "queued"]).library

    XCTAssertEqual(
      plan.dropExcluded, ["queued"], "videos turned off: the library of videos lists nothing")
    XCTAssertEqual(plan.libraryPhotoIDs, [])
    let sent = try await state(store, "sent")
    XCTAssertEqual(sent, .uploaded)
    let queued = try await state(store, "queued")
    XCTAssertNil(queued)
  }

  func testAnExcludedPendingRetryOwingCompanionsIsParkedUntilItsPhotoIsListedAgain() async throws {
    let store = try freshStore()
    try await store.upsert([row("retry", .pending, retryCount: 3)])
    try await store.markCompanionsOwed(id("retry"))

    let off = try await walk(
      store, listing: [asset("other")], previouslySeen: ["other", "retry"], inPhotoKit: ["retry"])

    XCTAssertEqual(off.library.suspend, ["retry"])
    XCTAssertEqual(off.library.forget, [])
    XCTAssertEqual(off.library.pendingPhotoIDs, ["other"], "a parked row is not pending work")
    let parked = try await state(store, "retry")
    XCTAssertEqual(parked, .skippedPolicy)
    let claimed = try await store.claimForUpload(id("retry"))
    XCTAssertFalse(claimed, "a retry already asleep in the engine must not upload it")
    let queue = InProcessBackupQueue()
    try await store.rehydrate(into: queue)
    let queued = await queue.snapshot().map(\.id)
    XCTAssertEqual(queued, [id("other")], "relaunch does not queue it either")
    let owing = try await store.phidsOwingCompanions(deviceId: device)
    XCTAssertEqual(owing, ["retry"])

    let on = try await walk(
      store, listing: [asset("other"), asset("retry")], previouslySeen: ["other"])

    XCTAssertEqual(on.reconcile.resume.map(\.id), [id("retry")])
    let resumed = try await store.find(id("retry"))
    XCTAssertEqual(resumed?.state, .pending)
    XCTAssertEqual(resumed?.retryCount, 3, "it picks up where it left off")
  }

  func testResumedTaskCarriesTheRetryCountItWasParkedWith() async throws {
    let store = try freshStore()
    try await store.upsert([row("retry", .pending, retryCount: 3)])
    _ = try await store.suspendExcluded([id("retry")])

    let resumed = try await store.resumeExcluded([row("retry", .pending)])

    XCTAssertEqual(
      resumed.map(\.retryCount), [3], "the engine counts its next retry from this task")
    XCTAssertEqual(resumed.map(\.state), [.pending])
  }

  func testAnEmptyListingWithNoLocalRowsIsAnEmptyLibrary() async throws {
    let store = try freshStore()

    let plan = try await walk(store, listing: []).library

    XCTAssertEqual(plan.libraryPhotoIDs, [])
    XCTAssertEqual(plan.forget, [])
  }

  func testReplayCountsTheLibraryTheSessionLastSawNotRowsAFullScanKept() async throws {
    let store = try freshStore()
    try await store.upsert([row("photo", .uploaded), row("video", .uploaded)])

    let plan = try await walk(
      store, listing: [asset("new")], isFullScan: false, previouslySeen: ["photo"]
    ).library

    XCTAssertEqual(plan.libraryPhotoIDs, ["photo", "new"])
    XCTAssertEqual(plan.backedUpPhotoIDs, ["photo"])
    XCTAssertEqual(plan.pendingPhotoIDs, ["new"])
  }

  func testSkippedPolicyPhotosAreNotPending() async throws {
    let store = try freshStore()
    try await store.upsert([row("skip", .skippedPolicy)])

    let plan = try await walk(store, listing: [asset("skip")], isFullScan: false).library

    XCTAssertEqual(plan.libraryPhotoIDs, ["skip"])
    XCTAssertEqual(plan.pendingPhotoIDs, [])
  }

  func testNewPhotosAreEnqueuedOnceAndNotAgainOnTheNextWalk() async throws {
    let store = try freshStore()
    let shot = Date(timeIntervalSince1970: 1_700_000_000)

    let first = try await walk(
      store, listing: [asset("A", capturedAt: shot), asset("B")]
    ).reconcile
    let second = try await walk(store, listing: [asset("A", capturedAt: shot), asset("B")])
      .reconcile

    XCTAssertEqual(first.enqueue.map(\.id), [id("A"), id("B")])
    XCTAssertEqual(first.enqueue.first?.capturedAt, shot)
    XCTAssertEqual(second.enqueue, [])
    let recorded = try await state(store, "A")
    XCTAssertEqual(recorded, .pending)
  }

  func testServerHeldPhotosAreSettledNotEnqueued() async throws {
    let store = try freshStore()
    try await store.upsert([row("failed", .failedRetry), row("done", .uploaded)])

    let plan = try await walk(
      store, listing: [asset("failed"), asset("done"), asset("new"), asset("fresh")],
      serverKnown: ["failed", "done", "new"]
    ).reconcile

    XCTAssertEqual(plan.settle.map(\.id), [id("failed"), id("new")])
    XCTAssertEqual(plan.enqueue.map(\.id), [id("fresh")])
    let failed = try await state(store, "failed")
    XCTAssertEqual(failed, .uploaded)
    let new = try await state(store, "new")
    XCTAssertEqual(new, .uploaded)
    let fresh = try await state(store, "fresh")
    XCTAssertEqual(fresh, .pending)
  }

  func testServerPhotosOutsideTheLibraryAreNotRecorded() async throws {
    let store = try freshStore()

    let plan = try await walk(
      store, listing: [asset("A")], serverKnown: ["A", "elsewhere"]
    ).reconcile

    XCTAssertEqual(plan.settle.map(\.id), [id("A")])
    XCTAssertEqual(plan.backedUpPhotoIDs, ["A"])
    let elsewhere = try await state(store, "elsewhere")
    XCTAssertNil(elsewhere)
  }

  func testAPhotoOwingCompanionsIsNeverBackedUpOrSettledByTheServerHoldingItsOriginal()
    async throws
  {
    let store = try freshStore()
    try await store.upsert([row("owing", .failedRetry), row("plain", .failedRetry)])
    try await store.markCompanionsOwed(id("owing"))

    let plan = try await walk(
      store, listing: [asset("owing"), asset("plain")], serverKnown: ["owing", "plain"]
    ).reconcile

    XCTAssertEqual(plan.serverBackedUpPhotoIDs, ["plain"])
    XCTAssertEqual(plan.backedUpPhotoIDs, ["plain"])
    let owing = try await state(store, "owing")
    XCTAssertEqual(owing, .failedRetry)
    let plain = try await state(store, "plain")
    XCTAssertEqual(plain, .uploaded)
  }

  func testRetryRequeuesFailedPhotosOnlyWhenAsked() async throws {
    let listing = ["failed", "pending", "done"].map { asset($0) }
    let rows = [row("failed", .failedRetry), row("pending", .pending), row("done", .uploaded)]

    let untouched = try freshStore()
    try await untouched.upsert(rows)
    let plain = try await walk(untouched, listing: listing).reconcile
    XCTAssertEqual(plain.retry, [])
    let stillFailed = try await state(untouched, "failed")
    XCTAssertEqual(stillFailed, .failedRetry)

    let restarted = try freshStore()
    try await restarted.upsert(rows)
    let plan = try await walk(restarted, listing: listing, retryFailed: true).reconcile
    XCTAssertEqual(plan.retry.map(\.id), [id("failed")])
    let failed = try await state(restarted, "failed")
    XCTAssertEqual(failed, .pending)
    let pending = try await state(restarted, "pending")
    XCTAssertEqual(pending, .pending)
    let done = try await state(restarted, "done")
    XCTAssertEqual(done, .uploaded)
  }

  func testDatesAreBackfilledOnlyForUndatedPendingRowsTheServerLacks() async throws {
    let store = try freshStore()
    let shot = Date(timeIntervalSince1970: 1_700_000_000)
    try await store.upsert([
      BackupTask(id: id("undated"), state: .pending, priority: .background),
      BackupTask(id: id("held"), state: .pending, priority: .background),
      BackupTask(
        id: id("dated"), state: .pending, priority: .background, capturedAt: shot),
    ])

    let plan = try await walk(
      store,
      listing: [
        asset("undated", capturedAt: shot), asset("held", capturedAt: shot),
        asset("dated", capturedAt: shot), asset("nodate"),
      ], serverKnown: ["held"]
    ).reconcile

    XCTAssertEqual(plan.datesToBackfill, ["undated": shot])
  }
}
