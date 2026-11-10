// Tests/MapleBackupTests/BackupNoChangeWalkTests.swift
// What a walk that finds nothing new costs when the device holds edits: the
// local-edit check reads and hashes only an edit that changed since it last
// looked, picks its candidates from the few stored edits rather than every
// uploaded photo, and an unchanged change token is not written again.
import Foundation
import XCTest

@testable import MapleBackup

final class BackupNoChangeWalkTests: XCTestCase {

  private func id(_ phid: String) -> BackupTaskID {
    BackupTaskID(deviceId: "d", phassetLocalId: phid)
  }

  private func deliveredEdit(
    _ phid: String, state: BackupStateStore, sidecars: AppSupportSidecarStore
  ) async throws {
    let xmp = "<x:edit>\(phid)</x:edit>"
    try await state.upsert(BackupTask(id: id(phid), state: .uploaded, priority: .background))
    try sidecars.write(phassetLocalId: phid, xmp: xmp)
    try await state.recordUploadedSidecar(
      id(phid), digest: BackupEngine.digest(of: xmp), canonicalName: true)
  }

  func testUnchangedEditsAreNotReadOrHashedAgain() async throws {
    let (engine, _, state, sidecars, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    for phid in ["A/L0/001", "B/L0/001", "C/L0/001"] {
      try await deliveredEdit(phid, state: state, sidecars: sidecars)
    }

    let first = await engine.hasUndeliveredEdits(deviceId: "d")
    XCTAssertFalse(first)
    XCTAssertEqual(sidecars.digestReads, 3)

    for _ in 0..<5 {
      let again = await engine.hasUndeliveredEdits(deviceId: "d")
      XCTAssertFalse(again)
    }
    XCTAssertEqual(sidecars.digestReads, 3, "unchanged edits must not be read or hashed again")

    try sidecars.write(phassetLocalId: "B/L0/001", xmp: "<x:edit>B, edited again</x:edit>")
    let edited = await engine.hasUndeliveredEdits(deviceId: "d")
    XCTAssertTrue(edited, "a changed edit is still noticed")
    XCTAssertEqual(sidecars.digestReads, 4, "and only that edit is read")
  }

  func testOnlyPhotosWithAStoredEditAreCandidates() async throws {
    let (engine, _, state, sidecars, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    try await state.upsert(
      (0..<200).map {
        BackupTask(id: id("P\($0)/L0/001"), state: .uploaded, priority: .background)
      })
    try await deliveredEdit("edited/L0/001", state: state, sidecars: sidecars)

    let candidates = try await state.uploadedPhotosWithEdits(
      deviceId: "d", sidecarFileNames: try sidecars.storedSidecarFileNames())
    XCTAssertEqual(candidates.map(\.phid), ["edited/L0/001"])
    XCTAssertEqual(
      candidates.first?.deliveredDigest, BackupEngine.digest(of: "<x:edit>edited/L0/001</x:edit>"))

    let undelivered = await engine.hasUndeliveredEdits(deviceId: "d")
    XCTAssertFalse(undelivered)
    XCTAssertEqual(sidecars.digestReads, 1)
  }

  func testEditsOnlyTheNonCanonicalNameHoldsAreCandidatesWithoutADeliveredDigest() async throws {
    let (_, _, state, sidecars, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    try await state.upsert(BackupTask(id: id("legacy"), state: .uploaded, priority: .background))
    try sidecars.write(phassetLocalId: "legacy", xmp: "<x:edit>legacy</x:edit>")
    try await state.recordUploadedSidecar(id("legacy"), digest: "old", canonicalName: false)

    let candidates = try await state.uploadedPhotosWithEdits(
      deviceId: "d", sidecarFileNames: try sidecars.storedSidecarFileNames())

    XCTAssertEqual(candidates.map(\.phid), ["legacy"])
    XCTAssertNil(candidates.first?.deliveredDigest)
  }

  func testUnchangedChangeTokenIsNotWrittenAgain() async throws {
    let (_, _, state, _, _, tmpRoot) = try freshHarness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let token = Data([1, 2, 3])

    let first = try await state.updatePhotoKitChangeToken(deviceId: "d", token: token)
    let repeated = try await state.updatePhotoKitChangeToken(deviceId: "d", token: token)
    let changed = try await state.updatePhotoKitChangeToken(deviceId: "d", token: Data([4]))

    XCTAssertTrue(first)
    XCTAssertFalse(repeated)
    XCTAssertTrue(changed)
    let stored = try await state.cursor(deviceId: "d").phChangeToken
    XCTAssertEqual(stored, Data([4]))
  }
}
