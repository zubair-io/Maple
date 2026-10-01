import XCTest

@testable import MapleCore

final class LocalRelocationJournalTests: XCTestCase {
  private func fixture(_ name: String) throws -> Data {
    let parts = name.split(separator: ".")
    return try Data(
      contentsOf: XCTUnwrap(
        Bundle.module.url(
          forResource: String(parts[0]),
          withExtension: String(parts[1]), subdirectory: "removal")))
  }

  private func plan(replace: Bool = true) async throws -> (URL, URL, RelocatePlan, String) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let album = root.appendingPathComponent("album")
    try FileManager.default.createDirectory(at: album, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("photo.dng")
    try fixture("source.dng").write(to: raw)
    try fixture("prior.xmp").write(to: SidecarPath.sidecarURL(for: raw))
    let records = try await LocalRemovalAssetStore(rawURL: raw).publish(
      request: String(decoding: fixture("request.txt"), as: UTF8.self), prior: "[]",
      mask: fixture("mask.mimf"), patch: fixture("patch.f16"))
    try await XMPSidecarStore(rawURL: raw).writeRemovalConfirmed(
      records: records,
      expectedRecords: "[]", model: .default, culling: CullingState())
    let target = album.appendingPathComponent("photo.dng")
    if replace {
      try Data("previous original".utf8).write(to: target)
      try Data("<previous-sidecar/>".utf8).write(to: SidecarPath.sidecarURL(for: target))
    }
    let plan = try await LocalFileOperations.planRelocate(
      raw, to: album, mode: .move,
      collision: .replace)
    return (raw, target, plan, records)
  }

  private func abandoned(_ target: URL, plan: RelocatePlan) throws -> RelocationJournalRecord {
    // Simulate loss of the in-memory owner. PID metadata deliberately remains
    // this live test process; recovery depends on the kernel lease, not PID.
    plan.localSnapshot?.lease?.release()
    return try LocalRelocationJournal.read(target: target)
  }

  private func restorePreviousXMP(_ target: URL, plan: RelocatePlan) throws {
    let sidecar = SidecarPath.sidecarURL(for: target)
    let backup = try XCTUnwrap(plan.localSnapshot?.backups[sidecar.path])
    try Data(contentsOf: URL(fileURLWithPath: backup)).write(to: sidecar, options: .atomic)
  }

  func testAbandonedCompleteCopyRetainsWholeEditAndSourceAndCleansJournal() async throws {
    let (raw, target, planned, records) = try await plan()
    _ = try abandoned(target, plan: planned)
    try LocalFileOperations.recoverLocalRelocation(at: target)
    XCTAssertEqual(try Data(contentsOf: target), try fixture("source.dng"))
    XCTAssertTrue(FileManager.default.fileExists(atPath: raw.path))
    let assets = try await LocalRemovalAssetStore(rawURL: target).readAssets(records: records)
    XCTAssertEqual(assets.count, 2)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: LocalRelocationJournal.url(for: target).path))
  }

  func testInterruptedPairRestoresPreviousOccupantAndPreservesIncomingEditCopy() async throws {
    let (raw, target, plan, records) = try await plan()
    try restorePreviousXMP(target, plan: plan)
    let record = try abandoned(target, plan: plan)
    try LocalFileOperations.recoverLocalRelocation(at: target)
    XCTAssertEqual(try Data(contentsOf: target), Data("previous original".utf8))
    XCTAssertEqual(
      try Data(contentsOf: SidecarPath.sidecarURL(for: target)), Data("<previous-sidecar/>".utf8))
    XCTAssertEqual(try Data(contentsOf: raw), try fixture("source.dng"))
    let retained = LocalRelocationJournal.incomingURL(record, target: target)
    XCTAssertEqual(try Data(contentsOf: retained), try fixture("source.dng"))
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: retained)), record.sidecarData)
    let assets = try await LocalRemovalAssetStore(rawURL: retained).readAssets(records: records)
    XCTAssertEqual(assets.count, 2)
    try RemovalBridge.verifySource(records: records, rawURL: retained)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: LocalRelocationJournal.url(for: target).path))
  }

  func testCrashAfterRestorationOrBackupCleanupCanFinishIdempotently() async throws {
    let (_, target, plan, _) = try await plan()
    try restorePreviousXMP(target, plan: plan)
    let backup = try XCTUnwrap(plan.localSnapshot?.backups[target.path])
    try Data(contentsOf: URL(fileURLWithPath: backup)).write(to: target, options: .atomic)
    _ = try abandoned(target, plan: plan)
    try FileManager.default.removeItem(atPath: backup)
    try LocalFileOperations.recoverLocalRelocation(at: target)
    XCTAssertEqual(try Data(contentsOf: target), Data("previous original".utf8))
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: LocalRelocationJournal.url(for: target).path))
    try LocalFileOperations.recoverLocalRelocation(at: target)
  }

  func testMissingSourceCannotDiscardIncomingOriginalDuringRollback() async throws {
    let (raw, target, plan, _) = try await plan()
    try restorePreviousXMP(target, plan: plan)
    _ = try abandoned(target, plan: plan)
    try FileManager.default.removeItem(at: raw)
    do {
      try LocalFileOperations.recoverLocalRelocation(at: target)
      XCTFail("The only remaining incoming original must not be replaced")
    } catch RemovalError.invalid {}
    XCTAssertEqual(try Data(contentsOf: target), try fixture("source.dng"))
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: LocalRelocationJournal.url(for: target).path))
  }

  func testLaterEditAndCorruptBackupCannotBeOverwritten() async throws {
    let (_, target, plan, _) = try await plan()
    _ = try abandoned(target, plan: plan)
    let later = Data("<a-later-edit/>".utf8)
    try later.write(to: SidecarPath.sidecarURL(for: target), options: .atomic)
    do {
      try LocalFileOperations.recoverLocalRelocation(at: target)
      XCTFail("Later sidecar bytes must survive recovery")
    } catch RemovalError.saveConflict {}
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: target)), later)
    try restorePreviousXMP(target, plan: plan)
    let backup = try XCTUnwrap(plan.localSnapshot?.backups[target.path])
    try Data("corrupt backup".utf8).write(to: URL(fileURLWithPath: backup))
    XCTAssertThrowsError(try LocalFileOperations.recoverLocalRelocation(at: target))
    XCTAssertEqual(try Data(contentsOf: target), try fixture("source.dng"))
  }

  func testMissingCompanionCannotDeclareAbandonedNewPairComplete() async throws {
    let (_, target, planned, records) = try await plan()
    _ = try abandoned(target, plan: planned)
    let name = try XCTUnwrap(RemovalBridge.assetNames(records: records).first)
    try FileManager.default.removeItem(
      at: target.deletingLastPathComponent().appendingPathComponent(".maple/inpaint/" + name))
    do {
      try LocalFileOperations.recoverLocalRelocation(at: target)
      XCTFail("Missing accepted assets must retain recovery evidence")
    } catch RemovalError.missingCompanion {}
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: LocalRelocationJournal.url(for: target).path))
  }

  func testActivePlanKeepsUndoRightsAndExternalDestinationEditRefusesRevert() async throws {
    let (_, target, plan, _) = try await plan()
    XCTAssertThrowsError(try LocalFileOperations.recoverLocalRelocation(at: target))
    let changed = Data("<later destination edit/>".utf8)
    try changed.write(to: SidecarPath.sidecarURL(for: target), options: .atomic)
    LocalFileOperations.revertPlan(plan)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: target)), changed)
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: LocalRelocationJournal.url(for: target).path))
    for backup in try XCTUnwrap(plan.localSnapshot).backups.values {
      XCTAssertTrue(FileManager.default.fileExists(atPath: backup))
    }
  }
  func testInterruptedNewDestinationRemovesOnlyItsStagedPairAndRetainsIncomingCopy() async throws {
    let (raw, target, planned, records) = try await plan(replace: false)
    try FileManager.default.removeItem(at: SidecarPath.sidecarURL(for: target))
    let record = try abandoned(target, plan: planned)
    try LocalFileOperations.recoverLocalRelocation(at: target)
    XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: SidecarPath.sidecarURL(for: target).path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: raw.path))
    let retained = LocalRelocationJournal.incomingURL(record, target: target)
    XCTAssertEqual(try Data(contentsOf: retained), try fixture("source.dng"))
    try RemovalBridge.verifySource(records: records, rawURL: retained)
    let assets = try await LocalRemovalAssetStore(rawURL: retained).readAssets(records: records)
    XCTAssertEqual(assets.count, 2)
  }

  func testJournalBackupTraversalAndChangedSnapshotCannotMutateFiles() async throws {
    let (_, target, planned, _) = try await plan()
    _ = try abandoned(target, plan: planned)
    let url = LocalRelocationJournal.url(for: target)
    let original = try Data(contentsOf: url)
    var json = try XCTUnwrap(JSONSerialization.jsonObject(with: original) as? [String: Any])
    var previous = try XCTUnwrap(json["previous"] as? [String: [String: Any]])
    previous[target.lastPathComponent]?["backup"] = "../../another-original.dng"
    json["previous"] = previous
    try JSONSerialization.data(withJSONObject: json).write(to: url, options: .atomic)
    XCTAssertThrowsError(try LocalFileOperations.recoverLocalRelocation(at: target))
    XCTAssertEqual(try Data(contentsOf: target), try fixture("source.dng"))
    try original.write(to: url, options: .atomic)
    json = try XCTUnwrap(JSONSerialization.jsonObject(with: original) as? [String: Any])
    json["sidecarData"] = Data("a changed sidecar snapshot".utf8).base64EncodedString()
    try JSONSerialization.data(withJSONObject: json).write(to: url, options: .atomic)
    XCTAssertThrowsError(try LocalFileOperations.recoverLocalRelocation(at: target))
    XCTAssertEqual(try Data(contentsOf: target), try fixture("source.dng"))
  }

  func testSidecarAsPrimaryOrTargetRefusesWithoutChangingPhoto() async throws {
    let (raw, target, planned, _) = try await plan()
    LocalFileOperations.revertPlan(planned)
    let xml = try Data(contentsOf: SidecarPath.sidecarURL(for: raw))
    for (source, basename) in [
      (SidecarPath.sidecarURL(for: raw), "another.dng"), (raw, "another.xmp"),
    ] {
      do {
        _ = try await LocalFileOperations.planRelocate(
          source,
          to: target.deletingLastPathComponent(), newBasename: basename, mode: .move)
        XCTFail("The primary and sidecar cannot share the same file")
      } catch FileOperationError.invalidName {}
    }
    XCTAssertEqual(try Data(contentsOf: raw), try fixture("source.dng"))
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: raw)), xml)
  }

  #if os(macOS)
    func testKernelReleasesLeaseAfterOwnerExitsWithoutCleanup() async throws {
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: root) }
      let target = root.appendingPathComponent("photo.dng")
      let path = root.appendingPathComponent(".photo.dng.relocation.lock").path
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
      process.arguments = [
        "-c",
        """
        import fcntl, os, sys
        descriptor = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print("locked", flush=True)
        sys.stdin.buffer.read(1)
        os._exit(0)  # No unlock, close, or interpreter cleanup.
        """, path,
      ]
      let request = Pipe()
      let response = Pipe()
      process.standardInput = request
      process.standardOutput = response
      process.standardError = Pipe()
      let locked = expectation(description: "Child holds the kernel lease")
      let exited = expectation(description: "Child exited without releasing the lease")
      response.fileHandleForReading.readabilityHandler = { handle in
        if !handle.availableData.isEmpty {
          handle.readabilityHandler = nil
          locked.fulfill()
        }
      }
      process.terminationHandler = { _ in exited.fulfill() }
      defer {
        response.fileHandleForReading.readabilityHandler = nil
        try? request.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
      }
      try process.run()
      await fulfillment(of: [locked], timeout: 5)
      guard process.isRunning else {
        throw FileOperationError.verificationFailed(
          "Lease test helper exited before owning its lock")
      }
      XCTAssertThrowsError(try LocalRelocationLease(target: target))
      try request.fileHandleForWriting.write(contentsOf: Data([1]))
      await fulfillment(of: [exited], timeout: 5)
      XCTAssertEqual(process.terminationStatus, 0)
      let recovered = try LocalRelocationLease(target: target)
      recovered.release()
    }

  #endif

}
