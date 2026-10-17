import GRDB
import XCTest

@testable import MapleBackup

final class BackupStorageTests: XCTestCase {
  func testMigrationPreservesIdentityWALAndRealXMPAndDoesNotReplay() async throws {
    let fm = FileManager.default
    let tmp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? fm.removeItem(at: tmp) }
    let legacy = tmp.appendingPathComponent("legacy")
    let group = tmp.appendingPathComponent("group")
    let sidecars = legacy.appendingPathComponent("PhotoKitSidecars")
    try fm.createDirectory(at: sidecars, withIntermediateDirectories: true)
    let idURL = legacy.appendingPathComponent("device-id")
    let id = try DeviceIdentity.current(storageURL: idURL)
    let xml = #"<x:xmpmeta xmlns:x="adobe:ns:meta/"><unknown>keep bytes</unknown></x:xmpmeta>"#
    try Data(xml.utf8).write(to: sidecars.appendingPathComponent("P1.xmp"))
    let dbURL = legacy.appendingPathComponent("backup-state-destination.sqlite")
    let state = try BackupStateStore(databaseURL: dbURL)
    let task = BackupTask(
      id: BackupTaskID(deviceId: id, phassetLocalId: "P1"), state: .pending, priority: .userEdit)
    try await state.upsert(task)
    let db = try DatabaseQueue(path: dbURL.path)
    try await db.writeWithoutTransaction { db in
      try db.execute(sql: "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
      try db.execute(sql: "UPDATE tasks SET retry_count=3")
    }
    XCTAssertTrue(fm.fileExists(atPath: dbURL.path + "-wal"))
    let root = try BackupStorage.migrate(groupRoot: group, legacyRoot: legacy)
    XCTAssertEqual(root, group.appendingPathComponent("Maple", isDirectory: true))
    XCTAssertEqual(
      try DeviceIdentity.current(storageURL: root.appendingPathComponent("device-id")), id)
    let restored = try BackupStateStore(
      databaseURL: root.appendingPathComponent(dbURL.lastPathComponent))
    let row = try await restored.find(task.id)
    XCTAssertEqual(row?.retryCount, 3)
    let store = AppSupportSidecarStore(root: root.appendingPathComponent("PhotoKitSidecars"))
    XCTAssertEqual(try store.read(phassetLocalId: "P1"), xml)
    try store.delete(phassetLocalId: "P1")
    _ = try BackupStorage.migrate(groupRoot: group, legacyRoot: legacy)
    XCTAssertNil(
      try store.read(phassetLocalId: "P1"), "Migration must not resurrect consumed edits")
    XCTAssertEqual(try Data(contentsOf: sidecars.appendingPathComponent("P1.xmp")), Data(xml.utf8))
  }

  func testExistingSharedFilesWinAndConcurrentIdentityIsStable() throws {
    let fm = FileManager.default
    let tmp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? fm.removeItem(at: tmp) }
    let legacy = tmp.appendingPathComponent("legacy")
    let group = tmp.appendingPathComponent("group")
    let root = group.appendingPathComponent("Maple")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    try fm.createDirectory(at: legacy, withIntermediateDirectories: true)
    try Data("old".utf8).write(to: legacy.appendingPathComponent("device-id"))
    let sharedID = try DeviceIdentity.current(storageURL: root.appendingPathComponent("device-id"))
    DispatchQueue.concurrentPerform(iterations: 16) { _ in
      do {
        let shared = try BackupStorage.migrate(groupRoot: group, legacyRoot: legacy)
        XCTAssertEqual(
          try DeviceIdentity.current(storageURL: shared.appendingPathComponent("device-id")),
          sharedID)
      } catch { XCTFail("Concurrent startup failed: \(error)") }
    }
  }

  func testConcurrentFirstIdentityHasOneValue() throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: root) }
    let ids = NSMutableSet()
    let mutex = NSLock()
    DispatchQueue.concurrentPerform(iterations: 16) { _ in
      do {
        let id = try DeviceIdentity.current(storageURL: root.appendingPathComponent("device-id"))
        mutex.withLock { ids.add(id) }
      } catch { XCTFail("First identity failed: \(error)") }
    }
    XCTAssertEqual(ids.count, 1)
  }

  func testFailedMigrationDoesNotPublishMarkerAndCanRetry() throws {
    let fm = FileManager.default
    let tmp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? fm.removeItem(at: tmp) }
    let legacy = tmp.appendingPathComponent("legacy")
    let group = tmp.appendingPathComponent("group")
    try fm.createDirectory(at: legacy, withIntermediateDirectories: true)
    let db = legacy.appendingPathComponent("backup-state-invalid.sqlite")
    try Data("invalid database".utf8).write(to: db)
    XCTAssertThrowsError(try BackupStorage.migrate(groupRoot: group, legacyRoot: legacy))
    XCTAssertFalse(
      fm.fileExists(atPath: group.appendingPathComponent("Maple/.backup-storage-v1").path))
    try fm.removeItem(at: db)
    let root = try BackupStorage.migrate(groupRoot: group, legacyRoot: legacy)
    XCTAssertTrue(fm.fileExists(atPath: root.appendingPathComponent(".backup-storage-v1").path))
  }
}
