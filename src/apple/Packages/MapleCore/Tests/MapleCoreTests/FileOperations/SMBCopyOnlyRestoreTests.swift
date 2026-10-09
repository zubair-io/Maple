import XCTest

@testable import MapleCore

/// #4139/#4173: over SMB, restore copies and never deletes or renames a file
/// that existed before it ran; the trash expiry sweep is the only deleter.
final class SMBCopyOnlyRestoreTests: XCTestCase {
  private let trashed = "/.maple/trash/2024/Paris/IMG_1.dng"
  private let trashedXMP = "/.maple/trash/2024/Paris/IMG_1.xmp"

  private func trashedPair() async throws -> FakeSMBTransport {
    let t = FakeSMBTransport()
    await t.seed("pixels", at: "/2024/Paris/IMG_1.dng")
    await t.seed("<xmp>edits</xmp>", at: "/2024/Paris/IMG_1.xmp")
    _ = try await SMBFileOperations.trash("/2024/Paris/IMG_1.dng", transport: t)
    return t
  }

  private func consumedTrashPaths(_ t: FakeSMBTransport) async -> [String] {
    await t.consumedPaths.filter { $0.hasPrefix("/.maple/trash/") }
  }

  func testRestoreCopiesThePairAndLeavesTheTrashedOriginalsHidden() async throws {
    let t = try await trashedPair()
    let before = await t.consumedPaths.count

    let outcome = try await SMBFileOperations.restoreFromMapleTrash(trashed, transport: t)

    XCTAssertEqual(outcome.primaryPath, "/2024/Paris/IMG_1.dng")
    XCTAssertEqual(outcome.sidecarPath, "/2024/Paris/IMG_1.xmp")
    let restoredPhoto = await t.fileContents(at: "/2024/Paris/IMG_1.dng")
    let restoredXMP = await t.fileContents(at: "/2024/Paris/IMG_1.xmp")
    let trashedPhoto = await t.fileContents(at: trashed)
    let trashedSidecar = await t.fileContents(at: trashedXMP)
    XCTAssertEqual(restoredPhoto, "pixels")
    XCTAssertEqual(restoredXMP, "<xmp>edits</xmp>")
    XCTAssertEqual(trashedPhoto, "pixels")
    XCTAssertEqual(trashedSidecar, "<xmp>edits</xmp>")
    let consumed = await t.consumedPaths.dropFirst(before)
    XCTAssertTrue(consumed.allSatisfy { $0.hasPrefix("/.maple/restore-staging/") }, "\(consumed)")
    let listed = await SMBFileOperations.listMapleTrash(transport: t)
    XCTAssertEqual(listed.count, 0)
  }

  func testBackingReplacementAtTheRestoreMarkSurvives() async throws {
    let t = try await trashedPair()
    await t.setReplacementAtRestoreMark(trashed, contents: "unrelated replacement")

    _ = try await SMBFileOperations.restoreFromMapleTrash(trashed, transport: t)

    let replacement = await t.fileContents(at: trashed)
    let restored = await t.fileContents(at: "/2024/Paris/IMG_1.dng")
    XCTAssertEqual(replacement, "unrelated replacement")
    XCTAssertEqual(restored, "pixels")
    let consumed = await consumedTrashPaths(t)
    XCTAssertEqual(consumed.filter { $0 == trashed || $0 == trashedXMP }, [])
  }

  func testFailedStagingCopyTouchesNothingAndAgesOutInTheSweep() async throws {
    let t = try await trashedPair()
    await t.setFailCopiesInto("/.maple/restore-staging")
    let before = await t.consumedPaths.count

    do {
      _ = try await SMBFileOperations.restoreFromMapleTrash(trashed, transport: t)
      XCTFail("expected the injected copy failure")
    } catch FakeSMBTransportError.injectedFailure {}

    let consumed = await t.consumedPaths.dropFirst(before)
    XCTAssertEqual(Array(consumed), [])
    let listed = await SMBFileOperations.listMapleTrash(transport: t)
    XCTAssertEqual(listed.map(\.primaryPath), [trashed])
    let staged = try await t.contentsOfDirectory(
      atPath: "/.maple/restore-staging", recursive: false)
    XCTAssertEqual(staged.count, 1)

    let fresh = await SMBFileOperations.sweepExpiredRestoreStaging(
      shareRoot: "/", olderThanDays: 30, now: Date(), transport: t)
    XCTAssertEqual(fresh, 0)
    let expired = await SMBFileOperations.sweepExpiredRestoreStaging(
      shareRoot: "/", olderThanDays: 30, now: Date().addingTimeInterval(40 * 86_400), transport: t)
    XCTAssertEqual(expired, 1)
    let remaining = try await t.contentsOfDirectory(
      atPath: "/.maple/restore-staging", recursive: false)
    XCTAssertEqual(remaining.count, 0)
    let original = await t.fileContents(at: trashed)
    XCTAssertEqual(original, "pixels")
  }

  func testTrashExpiryIsTheOnlyDeleterOfARestoredItem() async throws {
    let t = try await trashedPair()
    _ = try await SMBFileOperations.restoreFromMapleTrash(trashed, transport: t)

    let early = await SMBFileOperations.sweepExpiredMapleTrash(olderThanDays: 30, transport: t)
    XCTAssertEqual(early, 0)
    let stillTrashed = await t.fileExists(at: trashed)
    XCTAssertTrue(stillTrashed)

    let purged = await SMBFileOperations.sweepExpiredMapleTrash(
      olderThanDays: 30, now: Date().addingTimeInterval(40 * 86_400), transport: t)

    XCTAssertEqual(purged, 1)
    let photoGone = await !t.fileExists(at: trashed)
    let sidecarGone = await !t.fileExists(at: trashedXMP)
    XCTAssertTrue(photoGone)
    XCTAssertTrue(sidecarGone)
    let restored = await t.fileContents(at: "/2024/Paris/IMG_1.dng")
    XCTAssertEqual(restored, "pixels")
    let markers = try await t.contentsOfDirectory(
      atPath: "/.maple/trash/2024/Paris", recursive: false)
    XCTAssertEqual(markers.count, 0)
  }

  func testAStaleRestoredMarkerNeverHidesANewlyTrashedFile() async throws {
    let t = FakeSMBTransport()
    try await t.createDirectory(
      atPath: "/.maple/trash/"
        + TrashMarker.markerName(
          forItemBasename: "IMG_2.dng", date: Date(), kind: .restored))
    await t.seed("new", at: "/IMG_2.dng")

    _ = try await SMBFileOperations.trash("/IMG_2.dng", transport: t)

    let listed = await SMBFileOperations.listMapleTrash(transport: t)
    XCTAssertEqual(listed.map(\.primaryPath), ["/.maple/trash/IMG_2.dng"])
  }

  func testMarkerKindsParseDistinctly() {
    let day = Date(timeIntervalSince1970: 1_790_000_000)
    let restored = TrashMarker.markerName(forItemBasename: "A.dng", date: day, kind: .restored)
    let trashed = TrashMarker.markerName(forItemBasename: "A.dng", date: day)
    XCTAssertEqual(TrashMarker.parseMarkerDirName(restored)?.kind, .restored)
    XCTAssertEqual(TrashMarker.parseMarkerDirName(trashed)?.kind, .trashed)
    XCTAssertNil(TrashMarker.date(fromMarkerName: restored, itemBasename: "A.dng"))
    XCTAssertNotNil(TrashMarker.date(fromMarkerName: trashed, itemBasename: "A.dng"))
    XCTAssertNil(TrashMarker.parseMarkerDirName("A.restored.dng"))
  }
}
